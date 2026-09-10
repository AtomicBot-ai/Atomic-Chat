use std::path::{Component, Path, PathBuf};

use async_trait::async_trait;

use super::super::tools::{ApprovalHook, DesktopServices, FolderAccessHook};
use super::super::types::{ApprovalDecision, ApprovalRequest, FolderAccessRequest};

pub struct WorkspaceApproval {
    root: PathBuf,
    skills_root: Option<PathBuf>,
}

impl WorkspaceApproval {
    pub fn new(root: &Path, skills_root: Option<&Path>) -> Result<Self, String> {
        let root = root
            .canonicalize()
            .map_err(|error| format!("Failed to resolve eval workspace: {error}"))?;
        let skills_root = match skills_root {
            Some(path) => Some(
                path.canonicalize()
                    .map_err(|error| format!("Failed to resolve eval skills dir: {error}"))?,
            ),
            None => None,
        };
        Ok(Self { root, skills_root })
    }

    fn resource_is_allowed(&self, kind: &str, value: &str) -> bool {
        match kind {
            // Benchmark tasks legitimately download over raw HTTP(S); the
            // tool's own SSRF guard still applies to the allowed request.
            "url" => {
                let value = value.trim_start().to_ascii_lowercase();
                value.starts_with("http://") || value.starts_with("https://")
            }
            "process" => false,
            "path" | "file" => {
                let path = Path::new(value);
                if path
                    .components()
                    .any(|component| matches!(component, Component::ParentDir))
                {
                    return false;
                }
                path.ancestors()
                    .find_map(|ancestor| ancestor.canonicalize().ok())
                    .is_some_and(|ancestor| {
                        ancestor.starts_with(&self.root)
                            || self
                                .skills_root
                                .as_ref()
                                .is_some_and(|skills| ancestor.starts_with(skills))
                    })
            }
            _ => true,
        }
    }
}

#[async_trait]
impl ApprovalHook for WorkspaceApproval {
    async fn is_allowed(&self, _fingerprint: &str) -> bool {
        false
    }

    async fn request(&self, request: ApprovalRequest) -> Result<ApprovalDecision, String> {
        if !request.affected_resources.is_empty()
            && request
                .affected_resources
                .iter()
                .all(|resource| self.resource_is_allowed(&resource.kind, &resource.value))
        {
            Ok(ApprovalDecision::AllowOnce)
        } else {
            Ok(ApprovalDecision::Deny)
        }
    }
}

pub struct DenyFolderAccess;

#[async_trait]
impl FolderAccessHook for DenyFolderAccess {
    async fn request(&self, _request: FolderAccessRequest) -> Result<bool, String> {
        Ok(false)
    }
}

pub struct HeadlessDesktop;

#[async_trait]
impl DesktopServices for HeadlessDesktop {
    async fn write_clipboard(&self, _text: String) -> Result<(), String> {
        Err("Clipboard is unavailable in GAIA evaluation".into())
    }

    async fn notify(&self, _title: String, _body: String) -> Result<(), String> {
        Err("Desktop notifications are unavailable in GAIA evaluation".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::agent::types::ApprovalResource;

    #[test]
    fn permits_paths_inside_workspace_and_rejects_escape() {
        let root = std::env::temp_dir().join(format!("atomic-gaia-hook-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let hook = WorkspaceApproval::new(&root, None).unwrap();
        assert!(hook.resource_is_allowed("path", &root.join("new.txt").to_string_lossy()));
        assert!(hook.resource_is_allowed("path", &root.join("new/deep/file.txt").to_string_lossy()));
        assert!(
            !hook.resource_is_allowed("path", &root.join("new/../../escape.txt").to_string_lossy())
        );
        assert!(!hook.resource_is_allowed("path", "/"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn permits_http_urls_and_bundled_skill_files_but_not_processes() {
        let base = std::env::temp_dir().join(format!("atomic-gaia-hook-{}", uuid::Uuid::new_v4()));
        let root = base.join("workspace");
        let skills = base.join("skills");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(skills.join("pdf")).unwrap();
        let hook = WorkspaceApproval::new(&root, Some(&skills)).unwrap();

        assert!(hook.resource_is_allowed("url", "https://example.com/paper.pdf"));
        assert!(hook.resource_is_allowed("url", "http://example.com/"));
        assert!(!hook.resource_is_allowed("url", "ftp://example.com/file"));
        assert!(!hook.resource_is_allowed("url", "file:///etc/passwd"));
        assert!(!hook.resource_is_allowed("process", "1234"));
        assert!(
            hook.resource_is_allowed("file", &skills.join("pdf/scripts/run.py").to_string_lossy())
        );
        assert!(hook.resource_is_allowed("path", &root.join("notes.txt").to_string_lossy()));
        assert!(!hook.resource_is_allowed("file", &base.join("outside.txt").to_string_lossy()));
        std::fs::remove_dir_all(base).unwrap();
    }

    #[tokio::test]
    async fn denies_resource_free_and_outside_workspace_approvals() {
        let root = std::env::temp_dir().join(format!("atomic-gaia-hook-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let hook = WorkspaceApproval::new(&root, None).unwrap();
        let request = |affected_resources| ApprovalRequest {
            tool: "os.shell.run".into(),
            reason: "approval-gated".into(),
            preview: serde_json::json!("command"),
            affected_resources,
            fingerprint: "fingerprint".into(),
            can_remember: false,
        };

        assert!(matches!(
            hook.request(request(Vec::new())).await.unwrap(),
            ApprovalDecision::Deny
        ));
        assert!(matches!(
            hook.request(request(vec![ApprovalResource {
                kind: "path".into(),
                value: root.join("../escape.txt").display().to_string(),
                operation: "write".into(),
            }]))
            .await
            .unwrap(),
            ApprovalDecision::Deny
        ));
        std::fs::remove_dir_all(root).unwrap();
    }
}
