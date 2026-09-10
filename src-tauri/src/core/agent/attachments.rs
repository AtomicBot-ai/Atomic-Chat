use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};

use super::session::validate_session_id;
use super::types::{AgentAttachment, AgentAttachmentKind};
use crate::core::threads::utils::{get_data_dir, get_thread_dir};

pub const MAX_AGENT_ATTACHMENTS: usize = 8;
const MAX_ATTACHMENT_BYTES: u64 = 50 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES: u64 = 100 * 1024 * 1024;
const MAX_ATTACHMENT_NAME_CHARS: usize = 255;
const ATTACHMENTS_DIR: &str = "agent-attachments";
const ATTACHMENT_URI_PREFIX: &str = "attachment://";

#[derive(Debug, Clone)]
pub struct StagedAttachment {
    pub kind: AgentAttachmentKind,
    pub name: String,
    pub media_type: Option<String>,
    pub path: PathBuf,
    pub original_path: Option<PathBuf>,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Default)]
pub struct StagedAttachments {
    pub trusted_root: Option<PathBuf>,
    pub items: Vec<StagedAttachment>,
}

impl StagedAttachments {
    pub fn has_images(&self) -> bool {
        self.items
            .iter()
            .any(|item| item.kind == AgentAttachmentKind::Image)
    }

    pub fn append_manifest(&self, user_message: &str) -> String {
        if self.items.is_empty() {
            return user_message.to_owned();
        }
        let mut text = String::with_capacity(user_message.len() + self.items.len() * 256);
        text.push_str(user_message);
        text.push_str("\n\n[ATTACHED_FILES]\n");
        for item in &self.items {
            let kind = match item.kind {
                AgentAttachmentKind::File => "file",
                AgentAttachmentKind::Image => "image",
            };
            let staged_name = item
                .path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("attachment.bin");
            let original_path = item
                .original_path
                .as_ref()
                .map(|path| {
                    serde_json::to_string(&path.to_string_lossy())
                        .expect("attachment path serializes as JSON")
                })
                .unwrap_or_else(|| "null".to_string());
            text.push_str(&format!(
                "- kind={kind}; name={}; mime={}; size={}; path={ATTACHMENT_URI_PREFIX}{staged_name}; original_path={original_path}\n",
                item.name,
                item.media_type
                    .as_deref()
                    .unwrap_or("application/octet-stream"),
                item.size_bytes
            ));
        }
        text.push_str(
            "Copy attachment:// paths exactly; they are virtual references resolved by the runtime. \
For file attachments, original_path is the canonical absolute path selected by the user. \
Use vision.describe for images, os.fs.read_document for supported documents, \
os.fs.read for text or source files, and archive tools for archives. Do not interpret \
unknown binary formats as text.\n[/ATTACHED_FILES]",
        );
        text
    }
}

pub async fn stage_attachments(
    data_folder: &Path,
    session_id: &str,
    attachments: &[AgentAttachment],
) -> Result<StagedAttachments, String> {
    validate_attachment_inputs(attachments)?;
    if attachments.is_empty() {
        return Ok(StagedAttachments::default());
    }
    validate_session_id(session_id)?;
    let threads_root = tokio::fs::canonicalize(get_data_dir(data_folder))
        .await
        .map_err(|error| format!("Could not resolve threads directory: {error}"))?;
    let thread_dir = tokio::fs::canonicalize(get_thread_dir(data_folder, session_id))
        .await
        .map_err(|error| format!("Could not resolve agent thread directory: {error}"))?;
    if thread_dir.parent() != Some(threads_root.as_path()) {
        return Err("Agent thread directory escapes the threads root".into());
    }

    let turn_dir = thread_dir
        .join(ATTACHMENTS_DIR)
        .join(uuid::Uuid::new_v4().to_string());
    tokio::fs::create_dir_all(&turn_dir)
        .await
        .map_err(|error| format!("Could not create Agent attachment directory: {error}"))?;

    match stage_all(&turn_dir, attachments).await {
        Ok(items) => {
            let trusted_root = tokio::fs::canonicalize(&turn_dir).await.map_err(|error| {
                format!("Could not resolve Agent attachment directory: {error}")
            })?;
            Ok(StagedAttachments {
                trusted_root: Some(trusted_root),
                items,
            })
        }
        Err(error) => {
            let _ = tokio::fs::remove_dir_all(&turn_dir).await;
            Err(error)
        }
    }
}

fn validate_attachment_inputs(attachments: &[AgentAttachment]) -> Result<(), String> {
    if attachments.len() > MAX_AGENT_ATTACHMENTS {
        return Err(format!(
            "Agent accepts at most {MAX_AGENT_ATTACHMENTS} attachments per turn"
        ));
    }
    for attachment in attachments {
        let name = attachment.name.trim();
        if name.is_empty() || name.chars().count() > MAX_ATTACHMENT_NAME_CHARS {
            return Err("Attachment name is empty or too long".into());
        }
        if Path::new(name).file_name().and_then(|value| value.to_str()) != Some(name) {
            return Err(format!(
                "Attachment name '{}' is not a file name",
                attachment.name
            ));
        }
        if name.contains(['/', '\\', '\0']) {
            return Err(format!(
                "Attachment name '{}' contains invalid characters",
                attachment.name
            ));
        }
        if name.chars().any(char::is_control) {
            return Err(format!(
                "Attachment name '{}' contains control characters",
                attachment.name
            ));
        }
        if let Some(media_type) = attachment.media_type.as_deref() {
            if media_type.is_empty()
                || media_type.len() > 127
                || !media_type
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"/+.-".contains(&byte))
            {
                return Err(format!(
                    "Attachment '{}' has an invalid media type",
                    attachment.name
                ));
            }
        }
        let sources =
            usize::from(attachment.path.is_some()) + usize::from(attachment.data_url.is_some());
        if sources != 1 {
            return Err(format!(
                "Attachment '{}' must provide exactly one source",
                attachment.name
            ));
        }
        match attachment.kind {
            AgentAttachmentKind::File if attachment.path.is_none() => {
                return Err(format!(
                    "File attachment '{}' requires path",
                    attachment.name
                ));
            }
            AgentAttachmentKind::Image if attachment.data_url.is_none() => {
                return Err(format!(
                    "Image attachment '{}' requires data_url",
                    attachment.name
                ));
            }
            _ => {}
        }
    }
    Ok(())
}

async fn stage_all(
    turn_dir: &Path,
    attachments: &[AgentAttachment],
) -> Result<Vec<StagedAttachment>, String> {
    let mut staged = Vec::with_capacity(attachments.len());
    let mut total_bytes = 0_u64;
    for (index, attachment) in attachments.iter().enumerate() {
        let (bytes, original_path) = match attachment.kind {
            AgentAttachmentKind::File => {
                let source = tokio::fs::canonicalize(
                    attachment.path.as_deref().expect("validated file path"),
                )
                .await
                .map_err(|error| {
                    format!(
                        "Could not resolve attachment '{}': {error}",
                        attachment.name
                    )
                })?;
                let metadata = tokio::fs::metadata(&source).await.map_err(|error| {
                    format!(
                        "Could not inspect attachment '{}': {error}",
                        attachment.name
                    )
                })?;
                if !metadata.is_file() {
                    return Err(format!(
                        "Attachment '{}' is not a regular file",
                        attachment.name
                    ));
                }
                enforce_size(attachment, metadata.len(), &mut total_bytes)?;
                let bytes = tokio::fs::read(&source).await.map_err(|error| {
                    format!("Could not read attachment '{}': {error}", attachment.name)
                })?;
                (bytes, Some(source))
            }
            AgentAttachmentKind::Image => (decode_image_data_url(attachment)?, None),
        };
        let size_bytes = u64::try_from(bytes.len()).map_err(|_| "Attachment is too large")?;
        if attachment.kind == AgentAttachmentKind::Image {
            enforce_size(attachment, size_bytes, &mut total_bytes)?;
        }
        let detected_image_media_type = match attachment.kind {
            AgentAttachmentKind::Image => Some(
                detect_image_media_type(&bytes)
                    .ok_or_else(|| {
                        format!(
                            "Image attachment '{}' is not a supported image",
                            attachment.name
                        )
                    })?
                    .to_owned(),
            ),
            AgentAttachmentKind::File => None,
        };
        let destination = match detected_image_media_type.as_deref() {
            Some(media_type) => turn_dir.join(staged_image_name(index, media_type)),
            None => turn_dir.join(staged_name(index, &attachment.name)),
        };
        tokio::fs::write(&destination, bytes)
            .await
            .map_err(|error| {
                format!("Could not stage attachment '{}': {error}", attachment.name)
            })?;
        staged.push(StagedAttachment {
            kind: attachment.kind.clone(),
            name: attachment.name.clone(),
            media_type: detected_image_media_type.or_else(|| attachment.media_type.clone()),
            path: destination,
            original_path,
            size_bytes,
        });
    }
    Ok(staged)
}

fn enforce_size(
    attachment: &AgentAttachment,
    size_bytes: u64,
    total_bytes: &mut u64,
) -> Result<(), String> {
    if size_bytes == 0 || size_bytes > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "Attachment '{}' must be between 1 byte and {MAX_ATTACHMENT_BYTES} bytes",
            attachment.name
        ));
    }
    *total_bytes = total_bytes
        .checked_add(size_bytes)
        .ok_or_else(|| "Total attachment size overflow".to_string())?;
    if *total_bytes > MAX_TOTAL_ATTACHMENT_BYTES {
        return Err(format!(
            "Agent attachments exceed the {MAX_TOTAL_ATTACHMENT_BYTES}-byte total limit"
        ));
    }
    Ok(())
}

fn decode_image_data_url(attachment: &AgentAttachment) -> Result<Vec<u8>, String> {
    let data_url = attachment.data_url.as_deref().expect("validated data URL");
    let (header, encoded) = data_url.split_once(',').ok_or_else(|| {
        format!(
            "Image attachment '{}' has an invalid data URL",
            attachment.name
        )
    })?;
    if !header.starts_with("data:image/") || !header.ends_with(";base64") {
        return Err(format!(
            "Image attachment '{}' requires a base64 image data URL",
            attachment.name
        ));
    }
    let estimated = encoded.len().saturating_mul(3) / 4;
    if estimated as u64 > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "Image attachment '{}' is too large",
            attachment.name
        ));
    }
    BASE64_STANDARD.decode(encoded).map_err(|error| {
        format!(
            "Image attachment '{}' is not valid base64: {error}",
            attachment.name
        )
    })
}

fn staged_name(index: usize, original: &str) -> String {
    let extension = Path::new(original)
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| value.len() <= 16 && value.chars().all(|ch| ch.is_ascii_alphanumeric()));
    match extension {
        Some(extension) => format!("{:02}.{}", index + 1, extension.to_ascii_lowercase()),
        None => format!("{:02}.bin", index + 1),
    }
}

fn staged_image_name(index: usize, media_type: &str) -> String {
    let extension = match media_type {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "bin",
    };
    format!("{:02}.{extension}", index + 1)
}

pub fn detect_image_media_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::threads::utils::ensure_thread_dir_exists;

    fn temp_data_folder() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "atomic-chat-agent-attachments-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn file_attachment(name: &str, path: &Path) -> AgentAttachment {
        AgentAttachment {
            kind: AgentAttachmentKind::File,
            name: name.into(),
            media_type: Some("text/plain".into()),
            path: Some(path.to_string_lossy().into_owned()),
            data_url: None,
        }
    }

    #[cfg(windows)]
    fn create_junction(link: &Path, target: &Path) {
        let output = std::process::Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .expect("run mklink /J");
        assert!(
            output.status.success(),
            "mklink /J failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[cfg(windows)]
    fn create_directory_symlink_if_allowed(link: &Path, target: &Path) -> bool {
        match std::os::windows::fs::symlink_dir(target, link) {
            Ok(()) => true,
            Err(error)
                if error.kind() == std::io::ErrorKind::PermissionDenied
                    || error.raw_os_error() == Some(1314) =>
            {
                false
            }
            Err(error) => panic!("create directory symlink: {error}"),
        }
    }

    #[tokio::test]
    async fn stages_files_and_images_under_the_owning_thread() {
        let data_folder = temp_data_folder();
        let session_id = "thread-attachments";
        ensure_thread_dir_exists(&data_folder, session_id).unwrap();
        let source = data_folder.join("source.txt");
        tokio::fs::write(&source, "fixture").await.unwrap();
        let attachments = vec![
            file_attachment("notes.txt", &source),
            AgentAttachment {
                kind: AgentAttachmentKind::Image,
                name: "pixel.png".into(),
                media_type: Some("image/png".into()),
                path: None,
                data_url: Some("data:image/png;base64,iVBORw0KGgo=".into()),
            },
        ];

        let staged = stage_attachments(&data_folder, session_id, &attachments)
            .await
            .unwrap();

        assert_eq!(staged.items.len(), 2);
        assert!(staged.has_images());
        let trusted_root = staged.trusted_root.as_ref().unwrap();
        let canonical_thread_dir =
            tokio::fs::canonicalize(get_thread_dir(&data_folder, session_id))
                .await
                .unwrap();
        assert!(trusted_root.starts_with(canonical_thread_dir));
        assert!(staged
            .items
            .iter()
            .all(|item| item.path.starts_with(trusted_root)));
        assert_eq!(
            tokio::fs::read(&staged.items[0].path).await.unwrap(),
            b"fixture"
        );
        let manifest = staged.append_manifest("Inspect the attachments.");
        assert!(manifest.contains("[ATTACHED_FILES]"));
        assert!(manifest.contains("name=notes.txt"));
        assert!(manifest.contains("path=attachment://01.txt"));
        assert!(manifest.contains(&format!(
            "original_path={}",
            serde_json::to_string(
                &tokio::fs::canonicalize(&source)
                    .await
                    .unwrap()
                    .to_string_lossy()
            )
            .unwrap()
        )));
        assert!(manifest.contains("path=attachment://02.png; original_path=null"));
        assert!(!manifest.contains(&trusted_root.to_string_lossy().into_owned()));
        assert!(manifest.contains("Use vision.describe for images"));
        assert!(!manifest.contains("iVBORw0KGgo"));

        std::fs::remove_dir_all(data_folder).unwrap();
    }

    #[tokio::test]
    async fn rejects_traversal_names_and_non_image_data_urls() {
        let data_folder = temp_data_folder();
        let session_id = "thread-invalid";
        ensure_thread_dir_exists(&data_folder, session_id).unwrap();
        let source = data_folder.join("source.txt");
        tokio::fs::write(&source, "fixture").await.unwrap();

        let traversal = vec![file_attachment("../escape.txt", &source)];
        assert!(stage_attachments(&data_folder, session_id, &traversal)
            .await
            .unwrap_err()
            .contains("not a file name"));

        let mismatched = vec![AgentAttachment {
            kind: AgentAttachmentKind::Image,
            name: "image.png".into(),
            media_type: Some("image/png".into()),
            path: None,
            data_url: Some("data:text/plain;base64,aGVsbG8=".into()),
        }];
        assert!(stage_attachments(&data_folder, session_id, &mismatched)
            .await
            .unwrap_err()
            .contains("requires a base64 image data URL"));

        std::fs::remove_dir_all(data_folder).unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn rejects_thread_directory_windows_reparse_point_escapes() {
        let data_folder = temp_data_folder();
        let threads_root = get_data_dir(&data_folder);
        std::fs::create_dir_all(&threads_root).unwrap();
        let outside = data_folder.join("outside-thread");
        std::fs::create_dir_all(&outside).unwrap();
        let source = data_folder.join("source.txt");
        std::fs::write(&source, "fixture").unwrap();
        let attachments = vec![file_attachment("source.txt", &source)];

        let junction_id = "junction-thread";
        let junction = get_thread_dir(&data_folder, junction_id);
        create_junction(&junction, &outside);
        assert!(stage_attachments(&data_folder, junction_id, &attachments)
            .await
            .unwrap_err()
            .contains("escapes"));
        std::fs::remove_dir(&junction).unwrap();

        let symlink_id = "symlink-thread";
        let symlink = get_thread_dir(&data_folder, symlink_id);
        if create_directory_symlink_if_allowed(&symlink, &outside) {
            assert!(stage_attachments(&data_folder, symlink_id, &attachments)
                .await
                .unwrap_err()
                .contains("escapes"));
            std::fs::remove_dir(&symlink).unwrap();
        }

        std::fs::remove_dir_all(data_folder).unwrap();
    }

    #[tokio::test]
    async fn stages_images_with_extensions_derived_from_their_bytes() {
        let data_folder = temp_data_folder();
        let session_id = "thread-image-signatures";
        ensure_thread_dir_exists(&data_folder, session_id).unwrap();
        let attachments = vec![
            AgentAttachment {
                kind: AgentAttachmentKind::Image,
                name: "mislabelled.png".into(),
                media_type: Some("image/png".into()),
                path: None,
                data_url: Some("data:image/jpeg;base64,/9j/cmVzdA==".into()),
            },
            AgentAttachment {
                kind: AgentAttachmentKind::Image,
                name: "also-mislabelled.png".into(),
                media_type: Some("image/png".into()),
                path: None,
                data_url: Some("data:image/webp;base64,UklGRgAAAABXRUJQ".into()),
            },
        ];

        let staged = stage_attachments(&data_folder, session_id, &attachments)
            .await
            .unwrap();

        assert_eq!(
            staged.items[0].path.file_name().unwrap().to_str(),
            Some("01.jpg")
        );
        assert_eq!(staged.items[0].media_type.as_deref(), Some("image/jpeg"));
        assert_eq!(
            staged.items[1].path.file_name().unwrap().to_str(),
            Some("02.webp")
        );
        assert_eq!(staged.items[1].media_type.as_deref(), Some("image/webp"));
        let manifest = staged.append_manifest("Inspect.");
        assert!(manifest.contains("mime=image/jpeg; size=7; path=attachment://01.jpg"));
        assert!(manifest.contains("mime=image/webp; size=12; path=attachment://02.webp"));

        std::fs::remove_dir_all(data_folder).unwrap();
    }

    #[tokio::test]
    async fn rejects_attachment_count_and_size_limits() {
        let data_folder = temp_data_folder();
        let session_id = "thread-limits";
        ensure_thread_dir_exists(&data_folder, session_id).unwrap();
        let source = data_folder.join("source.txt");
        tokio::fs::write(&source, "fixture").await.unwrap();

        let too_many = (0..=MAX_AGENT_ATTACHMENTS)
            .map(|index| file_attachment(&format!("{index}.txt"), &source))
            .collect::<Vec<_>>();
        assert!(stage_attachments(&data_folder, session_id, &too_many)
            .await
            .unwrap_err()
            .contains("at most"));

        let oversized = data_folder.join("oversized.bin");
        let file = std::fs::File::create(&oversized).unwrap();
        file.set_len(MAX_ATTACHMENT_BYTES + 1).unwrap();
        let too_large = vec![file_attachment("oversized.bin", &oversized)];
        assert!(stage_attachments(&data_folder, session_id, &too_large)
            .await
            .unwrap_err()
            .contains("must be between"));

        std::fs::remove_dir_all(data_folder).unwrap();
    }
}
