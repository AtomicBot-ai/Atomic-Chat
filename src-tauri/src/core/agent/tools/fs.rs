use std::path::Path;

use serde_json::Value;
use sha2::{Digest, Sha256, Sha512};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::process::Command;

use super::{
    command_outcome, optional_usize, required_string, resolve_path, truncate, ToolContext,
    MAX_TOOL_OUTPUT_CHARS,
};
use crate::core::agent::types::ToolOutcome;

pub async fn execute(
    tool: &str,
    args: &Value,
    context: &ToolContext<'_>,
) -> Result<ToolOutcome, ToolOutcome> {
    match tool {
        "os.fs.read" | "os.fs.read_document" => read(args, context).await,
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
    } else {
        tokio::fs::write(&path, content)
            .await
            .map_err(|error| ToolOutcome::error(error.to_string()))?;
    }
    Ok(ToolOutcome::ok(format!(
        "Wrote {} bytes to {} ({mode})",
        content.len(),
        path.display()
    )))
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
    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|error| ToolOutcome::error(error.to_string()))?;
    if content.matches(&old).count() != 1 {
        return Err(ToolOutcome::error(
            "oldString must match exactly once; file was not changed",
        ));
    }
    let updated = content.replacen(&old, new, 1);
    let mut file = tokio::fs::File::create(&path)
        .await
        .map_err(|error| ToolOutcome::error(error.to_string()))?;
    file.write_all(updated.as_bytes())
        .await
        .map_err(|error| ToolOutcome::error(error.to_string()))?;
    Ok(ToolOutcome::ok(format!("Edited {}", path.display())))
}

async fn trash(args: &Value, context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let source = resolve_path(
        context.working_dir,
        &required_string(args, "path").map_err(ToolOutcome::error)?,
    );
    let trash_root = dirs::home_dir()
        .map(|home| {
            if cfg!(target_os = "macos") {
                home.join(".Trash")
            } else {
                home.join(".local/share/Trash/files")
            }
        })
        .ok_or_else(|| ToolOutcome::error("Could not resolve trash directory"))?;
    tokio::fs::create_dir_all(&trash_root)
        .await
        .map_err(|error| ToolOutcome::error(error.to_string()))?;
    let name = source
        .file_name()
        .ok_or_else(|| ToolOutcome::error("Path has no file name"))?;
    let destination = trash_root.join(format!(
        "{}-{}",
        chrono::Utc::now().timestamp_millis(),
        name.to_string_lossy()
    ));
    tokio::fs::rename(&source, &destination)
        .await
        .map_err(|error| ToolOutcome::error(error.to_string()))?;
    Ok(ToolOutcome::ok(format!(
        "Moved {} to trash",
        source.display()
    )))
}

async fn patch(args: &Value, context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let patch_text = required_string(args, "patch").map_err(ToolOutcome::error)?;
    let apply = args.get("apply").and_then(Value::as_bool).unwrap_or(false);
    let mut child = Command::new("patch")
        .args(if apply {
            vec!["--batch", "-p0"]
        } else {
            vec!["--batch", "--dry-run", "-p0"]
        })
        .current_dir(context.working_dir)
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
    command_outcome(output)
}
