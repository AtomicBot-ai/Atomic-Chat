use std::path::Path;

use serde_json::Value;
use sha2::{Digest, Sha256, Sha512};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::process::Command;

use super::{
    command_outcome, optional_usize, required_string, resolve_path, truncate, ToolContext,
    MAX_TOOL_OUTPUT_CHARS,
};
use crate::core::agent::path_policy::MAX_TRASH_PATHS;
use crate::core::agent::types::{ToolOutcome, ToolStatus};

pub async fn execute(
    tool: &str,
    args: &Value,
    context: &ToolContext<'_>,
) -> Result<ToolOutcome, ToolOutcome> {
    match tool {
        "os.fs.read" => read(args, context).await,
        "os.fs.read_document" => read_document(args, context).await,
        "os.fs.list" => list(args, context).await,
        "os.fs.glob" => glob_paths(args, context).await,
        "os.fs.grep" => grep(args, context).await,
        "os.fs.hash" => hash(args, context).await,
        "os.fs.diff" => diff(args, context).await,
        "os.fs.write" => write(args, context).await,
        "os.fs.mkdir" => mkdir(args, context).await,
        "os.fs.edit" => edit(args, context).await,
        "os.fs.trash" => trash(args, context).await,
        "os.fs.patch" => patch(args, context).await,
        _ => Err(ToolOutcome::error(format!("Unsupported fs tool: {tool}"))),
    }
}

async fn read(args: &Value, context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let path = resolve_path(
        context.working_dir,
        &required_string(args, "path").map_err(ToolOutcome::error)?,
    );
    let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0);
    let limit = optional_usize(args, "limit", MAX_TOOL_OUTPUT_CHARS, MAX_TOOL_OUTPUT_CHARS);
    let mut file = tokio::fs::File::open(&path)
        .await
        .map_err(|error| ToolOutcome::error(format!("{}: {error}", path.display())))?;
    file.seek(std::io::SeekFrom::Start(offset))
        .await
        .map_err(|error| ToolOutcome::error(error.to_string()))?;
    let mut buffer = vec![0_u8; limit.saturating_add(1)];
    let read = file
        .read(&mut buffer)
        .await
        .map_err(|error| ToolOutcome::error(error.to_string()))?;
    buffer.truncate(read.min(limit));
    let text = String::from_utf8(buffer)
        .map_err(|_| ToolOutcome::error("File is not valid UTF-8 text"))?;
    Ok(ToolOutcome::ok(text))
}

async fn read_document(
    args: &Value,
    context: &ToolContext<'_>,
) -> Result<ToolOutcome, ToolOutcome> {
    let path = resolve_path(
        context.working_dir,
        &required_string(args, "path").map_err(ToolOutcome::error)?,
    );
    let max_chars = optional_usize(args, "maxChars", MAX_TOOL_OUTPUT_CHARS, 50_000);
    let file_type = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let path_string = path
        .to_str()
        .ok_or_else(|| ToolOutcome::error("Document path is not valid UTF-8"))?
        .to_owned();
    let text = tokio::task::spawn_blocking(move || {
        tauri_plugin_rag::parse_document(&path_string, &file_type)
    })
    .await
    .map_err(|error| ToolOutcome::error(format!("Document parser task failed: {error}")))?
    .map_err(|error| ToolOutcome::error(format!("{}: {error}", path.display())))?;
    let original_chars = text.chars().count();
    Ok(ToolOutcome {
        status: crate::core::agent::types::ToolStatus::Ok,
        summary: truncate(text, max_chars),
        details: Some(serde_json::json!({
            "path": path,
            "originalChars": original_chars,
            "truncated": original_chars > max_chars,
        })),
    })
}

async fn list(args: &Value, context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let raw = args.get("path").and_then(Value::as_str).unwrap_or(".");
    let path = resolve_path(context.working_dir, raw);
    let mut entries = tokio::fs::read_dir(&path)
        .await
        .map_err(|error| ToolOutcome::error(format!("{}: {error}", path.display())))?;
    let mut rows = Vec::new();
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|error| ToolOutcome::error(error.to_string()))?
    {
        let kind = entry
            .file_type()
            .await
            .map(|value| if value.is_dir() { "dir" } else { "file" })
            .unwrap_or("unknown");
        rows.push(format!("{kind}\t{}", entry.file_name().to_string_lossy()));
    }
    rows.sort();
    Ok(ToolOutcome::ok(truncate(
        rows.join("\n"),
        MAX_TOOL_OUTPUT_CHARS,
    )))
}

async fn glob_paths(args: &Value, context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let pattern = required_string(args, "pattern").map_err(ToolOutcome::error)?;
    let base = args
        .get("cwd")
        .and_then(Value::as_str)
        .map(|value| resolve_path(context.working_dir, value))
        .unwrap_or_else(|| context.working_dir.to_path_buf());
    let absolute_pattern = base.join(pattern).to_string_lossy().to_string();
    let paths = glob::glob(&absolute_pattern)
        .map_err(|error| ToolOutcome::error(error.to_string()))?
        .filter_map(Result::ok)
        .map(|path| {
            path.strip_prefix(&base)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string()
        })
        .collect::<Vec<_>>();
    Ok(ToolOutcome::ok(truncate(
        paths.join("\n"),
        MAX_TOOL_OUTPUT_CHARS,
    )))
}

async fn grep(args: &Value, context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let pattern = required_string(args, "pattern").map_err(ToolOutcome::error)?;
    let path = args
        .get("path")
        .and_then(Value::as_str)
        .map(|value| resolve_path(context.working_dir, value))
        .unwrap_or_else(|| context.working_dir.to_path_buf());
    let mut command = Command::new("rg");
    command
        .arg("--line-number")
        .arg("--color=never")
        .arg("--")
        .arg(pattern)
        .arg(path)
        .current_dir(context.working_dir);
    let output = command
        .output()
        .await
        .map_err(|error| ToolOutcome::error(format!("Could not run rg: {error}")))?;
    if output.status.code() == Some(1) {
        return Ok(ToolOutcome::ok("No matches"));
    }
    command_outcome(output)
}

async fn hash(args: &Value, context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let path = resolve_path(
        context.working_dir,
        &required_string(args, "path").map_err(ToolOutcome::error)?,
    );
    let algorithm = args
        .get("algorithm")
        .and_then(Value::as_str)
        .unwrap_or("sha256");
    if matches!(algorithm, "md5" | "sha1") {
        return hash_with_system_tool(&path, algorithm).await;
    }
    let mut file = tokio::fs::File::open(&path)
        .await
        .map_err(|error| ToolOutcome::error(error.to_string()))?;
    let mut bytes = [0_u8; 64 * 1024];
    match algorithm {
        "sha256" => {
            let mut digest = Sha256::new();
            loop {
                let count = file
                    .read(&mut bytes)
                    .await
                    .map_err(|error| ToolOutcome::error(error.to_string()))?;
                if count == 0 {
                    break;
                }
                digest.update(&bytes[..count]);
            }
            Ok(ToolOutcome::ok(format!("{:x}", digest.finalize())))
        }
        "sha512" => {
            let mut digest = Sha512::new();
            loop {
                let count = file
                    .read(&mut bytes)
                    .await
                    .map_err(|error| ToolOutcome::error(error.to_string()))?;
                if count == 0 {
                    break;
                }
                digest.update(&bytes[..count]);
            }
            Ok(ToolOutcome::ok(format!("{:x}", digest.finalize())))
        }
        _ => Err(ToolOutcome::error("Unsupported hash algorithm")),
    }
}

async fn hash_with_system_tool(path: &Path, algorithm: &str) -> Result<ToolOutcome, ToolOutcome> {
    let (program, arguments): (&str, Vec<String>) = if cfg!(target_os = "macos") {
        (
            if algorithm == "md5" { "md5" } else { "shasum" },
            if algorithm == "md5" {
                vec![path.to_string_lossy().into_owned()]
            } else {
                vec!["-a".into(), "1".into(), path.to_string_lossy().into_owned()]
            },
        )
    } else if cfg!(windows) {
        (
            "certutil",
            vec![
                "-hashfile".into(),
                path.to_string_lossy().into_owned(),
                algorithm.to_uppercase(),
            ],
        )
    } else {
        (
            if algorithm == "md5" {
                "md5sum"
            } else {
                "sha1sum"
            },
            vec![path.to_string_lossy().into_owned()],
        )
    };
    let output = Command::new(program)
        .args(arguments)
        .output()
        .await
        .map_err(|error| ToolOutcome::error(error.to_string()))?;
    command_outcome(output)
}

async fn diff(args: &Value, context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let left = required_string(args, "pathA").map_err(ToolOutcome::error)?;
    let right = required_string(args, "pathB").map_err(ToolOutcome::error)?;
    let output = Command::new("diff")
        .args(["-u", "--"])
        .arg(resolve_path(context.working_dir, &left))
        .arg(resolve_path(context.working_dir, &right))
        .output()
        .await
        .map_err(|error| ToolOutcome::error(error.to_string()))?;
    if matches!(output.status.code(), Some(0 | 1)) {
        return Ok(ToolOutcome::ok(truncate(
            String::from_utf8_lossy(&output.stdout).into_owned(),
            MAX_TOOL_OUTPUT_CHARS,
        )));
    }
    command_outcome(output)
}

async fn write(args: &Value, context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let path = resolve_path(
        context.working_dir,
        &required_string(args, "path").map_err(ToolOutcome::error)?,
    );
    let content = args
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolOutcome::error("Missing string argument `content`"))?;
    let mode = if args.get("mode").and_then(Value::as_str) == Some("append") {
        "append"
    } else {
        "replace"
    };
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| ToolOutcome::error(error.to_string()))?;
    }
    if mode == "append" {
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await
            .map_err(|error| ToolOutcome::error(error.to_string()))?;
        file.write_all(content.as_bytes())
            .await
            .map_err(|error| ToolOutcome::error(error.to_string()))?;
        file.flush()
            .await
            .map_err(|error| ToolOutcome::error(error.to_string()))?;
    } else {
        atomic_write(&path, content.as_bytes()).await?;
    }
    Ok(ToolOutcome {
        status: ToolStatus::Ok,
        summary: format!(
            "Wrote {} bytes to {} ({mode})",
            content.len(),
            path.display()
        ),
        details: Some(serde_json::json!({
            "path": path,
            "mode": mode,
            "bytesWritten": content.len(),
        })),
    })
}

async fn mkdir(args: &Value, context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let path = resolve_path(
        context.working_dir,
        &required_string(args, "path").map_err(ToolOutcome::error)?,
    );
    let recursive = args
        .get("recursive")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let result = if recursive {
        tokio::fs::create_dir_all(&path).await
    } else {
        tokio::fs::create_dir(&path).await
    };
    result.map_err(|error| ToolOutcome::error(format!("{}: {error}", path.display())))?;
    Ok(ToolOutcome::ok(format!(
        "Created directory {} (recursive={recursive})",
        path.display()
    )))
}

async fn edit(args: &Value, context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let path = resolve_path(
        context.working_dir,
        &required_string(args, "path").map_err(ToolOutcome::error)?,
    );
    let old = required_string(args, "oldString").map_err(ToolOutcome::error)?;
    let new = args
        .get("newString")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolOutcome::error("Missing string argument `newString`"))?;
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| ToolOutcome::error(format!("{}: {error}", path.display())))?;
    if !metadata.is_file() {
        return Err(ToolOutcome::error(format!(
            "{} is not a regular file",
            path.display()
        )));
    }
    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|error| ToolOutcome::error(error.to_string()))?;
    let match_count = content.matches(&old).count();
    let replace_all = args
        .get("replaceAll")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if match_count == 0 || (!replace_all && match_count != 1) {
        return Err(ToolOutcome::error(if replace_all {
            "oldString was not found; file was not changed"
        } else {
            "oldString must match exactly once; file was not changed"
        }));
    }
    let updated = if replace_all {
        content.replace(&old, new)
    } else {
        content.replacen(&old, new, 1)
    };
    let replacements = if replace_all { match_count } else { 1 };
    let bytes_before = content.len();
    let bytes_after = updated.len();
    atomic_write(&path, updated.as_bytes()).await?;
    Ok(ToolOutcome {
        status: ToolStatus::Ok,
        summary: format!(
            "Edited {} ({} replacement{})",
            path.display(),
            replacements,
            if replacements != 1 { "s" } else { "" }
        ),
        details: Some(serde_json::json!({
            "path": path,
            "replaceAll": replace_all,
            "replacements": replacements,
            "bytesBefore": bytes_before,
            "bytesAfter": bytes_after,
        })),
    })
}

async fn trash(args: &Value, context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let raw_paths = args
        .get("paths")
        .and_then(Value::as_array)
        .ok_or_else(|| ToolOutcome::error("Missing array argument `paths`"))?;
    if raw_paths.is_empty() || raw_paths.len() > MAX_TRASH_PATHS {
        return Err(ToolOutcome::error(format!(
            "`paths` must contain 1..={MAX_TRASH_PATHS} entries"
        )));
    }
    let mut paths = Vec::with_capacity(raw_paths.len());
    for raw in raw_paths {
        let raw = raw
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| ToolOutcome::error("`paths` must contain non-empty strings"))?;
        let path = resolve_path(context.working_dir, raw);
        tokio::fs::symlink_metadata(&path)
            .await
            .map_err(|error| ToolOutcome::error(format!("{}: {error}", path.display())))?;
        if path.file_name().is_none() {
            return Err(ToolOutcome::error(format!(
                "{} has no file name",
                path.display()
            )));
        }
        paths.push(path);
    }
    for (index, path) in paths.iter().enumerate() {
        if let Err(error) = trash_one(path).await {
            return Err(ToolOutcome::error(format!(
                "Trash failed at paths[{index}] '{}': {error}; {index} item(s) already moved",
                path.display()
            )));
        }
    }
    Ok(ToolOutcome {
        status: ToolStatus::Ok,
        summary: format!("Moved {} item(s) to the system trash", paths.len()),
        details: Some(serde_json::json!({
            "count": paths.len(),
            "paths": paths,
        })),
    })
}

async fn patch(args: &Value, context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let patch_text = required_string(args, "patch").map_err(ToolOutcome::error)?;
    let apply = args.get("apply").and_then(Value::as_bool).unwrap_or(false);
    let dry_run = run_patch(&patch_text, context.working_dir, true).await?;
    if !dry_run.status.success() {
        return command_outcome(dry_run);
    }
    if !apply {
        return command_outcome(dry_run);
    }
    command_outcome(run_patch(&patch_text, context.working_dir, false).await?)
}

async fn run_patch(
    patch_text: &str,
    working_dir: &Path,
    dry_run: bool,
) -> Result<std::process::Output, ToolOutcome> {
    let mut arguments = vec!["--batch"];
    if dry_run {
        arguments.push("--dry-run");
    }
    arguments.push("-p0");
    let mut child = Command::new("patch")
        .args(arguments)
        .current_dir(working_dir)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| ToolOutcome::error(error.to_string()))?;
    child
        .stdin
        .take()
        .ok_or_else(|| ToolOutcome::error("Patch stdin unavailable"))?
        .write_all(patch_text.as_bytes())
        .await
        .map_err(|error| ToolOutcome::error(error.to_string()))?;
    let output = child
        .wait_with_output()
        .await
        .map_err(|error| ToolOutcome::error(error.to_string()))?;
    Ok(output)
}

async fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), ToolOutcome> {
    let parent = path
        .parent()
        .ok_or_else(|| ToolOutcome::error(format!("{} has no parent", path.display())))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| ToolOutcome::error(format!("{} has no file name", path.display())))?
        .to_string_lossy();
    let temporary = parent.join(format!(".{file_name}.atomic-{}.tmp", uuid::Uuid::new_v4()));
    let result = async {
        let mut file = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .await?;
        file.write_all(bytes).await?;
        file.flush().await?;
        file.sync_all().await?;
        if let Ok(metadata) = tokio::fs::metadata(path).await {
            tokio::fs::set_permissions(&temporary, metadata.permissions()).await?;
        }
        atomic_replace(&temporary, path).await
    }
    .await;
    if let Err(error) = result {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(ToolOutcome::error(format!("{}: {error}", path.display())));
    }
    Ok(())
}

#[cfg(not(windows))]
async fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    tokio::fs::rename(source, destination).await
}

#[cfg(windows)]
async fn atomic_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

async fn trash_one(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return run_trash_command(
            "osascript",
            &[
                "-e",
                "on run argv",
                "-e",
                "set targetItem to POSIX file (item 1 of argv) as alias",
                "-e",
                "tell application \"Finder\" to delete targetItem",
                "-e",
                "end run",
                "--",
            ],
            path,
        )
        .await;
    }
    #[cfg(target_os = "linux")]
    {
        match run_trash_command("gio", &["trash", "--"], path).await {
            Ok(()) => return Ok(()),
            Err(gio_error) => {
                return run_trash_command("trash-put", &["--"], path)
                    .await
                    .map_err(|fallback| format!("gio: {gio_error}; trash-put: {fallback}"));
            }
        }
    }
    #[cfg(windows)]
    {
        return run_trash_command(
            "powershell",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Add-Type -AssemblyName Microsoft.VisualBasic; $p=$args[0]; $ui=[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs; $recycle=[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin; if ((Get-Item -LiteralPath $p).PSIsContainer) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, $ui, $recycle) } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, $ui, $recycle) }",
            ],
            path,
        )
        .await;
    }
    #[allow(unreachable_code)]
    Err("System trash is unsupported on this platform".into())
}

async fn run_trash_command(program: &str, arguments: &[&str], path: &Path) -> Result<(), String> {
    let output = Command::new(program)
        .args(arguments)
        .arg(path)
        .output()
        .await
        .map_err(|error| format!("could not run {program}: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    Err(if stderr.is_empty() {
        format!("{program} exited with {}", output.status)
    } else {
        format!("{program} exited with {}: {stderr}", output.status)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn atomic_write_cleans_temporary_file_when_replace_fails() {
        let temp = tempfile::tempdir().unwrap();
        let destination = temp.path().join("destination");
        std::fs::create_dir(&destination).unwrap();
        std::fs::write(destination.join("keep.txt"), b"keep").unwrap();

        assert!(atomic_write(&destination, b"replacement").await.is_err());
        assert_eq!(
            std::fs::read(destination.join("keep.txt")).unwrap(),
            b"keep"
        );
        let siblings = std::fs::read_dir(temp.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(siblings, vec!["destination"]);
    }

    #[tokio::test]
    async fn atomic_write_replaces_file_without_leaving_a_sibling_temp() {
        let temp = tempfile::tempdir().unwrap();
        let destination = temp.path().join("file.txt");
        std::fs::write(&destination, b"before").unwrap();

        atomic_write(&destination, b"after").await.unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"after");
        let siblings = std::fs::read_dir(temp.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(siblings, vec!["file.txt"]);
    }
}
