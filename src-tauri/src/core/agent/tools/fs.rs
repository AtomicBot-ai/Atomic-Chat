use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use diffy::{apply, create_patch, Patch};
use ignore::WalkBuilder;
use regex::Regex;
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

/// Upper bound for in-process text reads used by grep/diff/patch.
const MAX_TEXT_FILE_BYTES: u64 = 1_048_576;

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
        .map(|path| display_relative_path(path.strip_prefix(&base).unwrap_or(&path)))
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
    let working_dir = context.working_dir.to_path_buf();
    let result = tokio::task::spawn_blocking(move || grep_sync(&pattern, &path, &working_dir))
        .await
        .map_err(|error| ToolOutcome::error(format!("Grep task failed: {error}")))?
        .map_err(ToolOutcome::error)?;
    Ok(ToolOutcome::ok(result))
}

fn grep_sync(pattern: &str, path: &Path, working_dir: &Path) -> Result<String, String> {
    let regex = Regex::new(pattern).map_err(|error| format!("Invalid regex: {error}"))?;
    let mut files = if path.is_file() {
        vec![path.to_path_buf()]
    } else if path.is_dir() {
        WalkBuilder::new(path)
            .follow_links(false)
            .standard_filters(true)
            .build()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_some_and(|kind| kind.is_file()))
            .map(|entry| entry.into_path())
            .collect::<Vec<_>>()
    } else {
        return Err(format!("{}: path does not exist", path.display()));
    };
    files.sort();

    let direct_file = path.is_file();
    let mut output = String::new();
    for file in files {
        let bytes = match read_text_file_bytes(&file) {
            Ok(bytes) => bytes,
            Err(_) if !direct_file => continue,
            Err(error) => return Err(error),
        };
        let text = match utf8_text(&bytes, &file) {
            Ok(text) => text,
            Err(_) if !direct_file => continue,
            Err(error) => return Err(error),
        };
        let display_path = display_relative_path(file.strip_prefix(working_dir).unwrap_or(&file));
        for (index, line) in text.lines().enumerate() {
            if regex.is_match(line) {
                output.push_str(&format!("{display_path}:{}:{line}\n", index + 1));
                if output.chars().count() > MAX_TOOL_OUTPUT_CHARS {
                    return Ok(truncate(output, MAX_TOOL_OUTPUT_CHARS));
                }
            }
        }
    }
    if output.is_empty() {
        Ok("No matches".into())
    } else {
        output.pop();
        Ok(output)
    }
}

/// Stable relative path labels for Agent observations (`/` on every platform).
fn display_relative_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn strip_windows_verbatim_prefix(path: &Path) -> PathBuf {
    let raw = path.to_string_lossy();
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = raw.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path.to_path_buf()
    }
}

/// Prefer a workspace-relative label after path-policy rewrites args to absolute
/// (and on Windows, verbatim) paths.
fn observation_path_label(working_dir: &Path, path: &Path) -> String {
    let path = display_relative_path(&strip_windows_verbatim_prefix(path));
    let working_dir = display_relative_path(&strip_windows_verbatim_prefix(working_dir))
        .trim_end_matches('/')
        .to_string();
    path.strip_prefix(&format!("{working_dir}/"))
        .unwrap_or(&path)
        .to_string()
}

fn format_unified_diff(left: &str, right: &str, left_text: &str, right_text: &str) -> String {
    if left_text == right_text {
        return String::new();
    }
    let generated = create_patch(left_text, right_text)
        .to_string()
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let body = generated.lines().skip(2).collect::<Vec<_>>().join("\n");
    if generated.ends_with('\n') {
        format!("--- {left}\n+++ {right}\n{body}\n")
    } else {
        format!("--- {left}\n+++ {right}\n{body}")
    }
}

fn utf8_text<'a>(bytes: &'a [u8], path: &Path) -> Result<&'a str, String> {
    if bytes.contains(&0) {
        return Err(format!(
            "{}: binary files are not supported",
            path.display()
        ));
    }
    std::str::from_utf8(bytes)
        .map_err(|_| format!("{}: file is not valid UTF-8 text", path.display()))
}

fn read_text_file_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let metadata =
        std::fs::metadata(path).map_err(|error| format!("{}: {error}", path.display()))?;
    if metadata.len() > MAX_TEXT_FILE_BYTES {
        return Err(format!(
            "{}: file exceeds the {} byte text-tool limit",
            path.display(),
            MAX_TEXT_FILE_BYTES
        ));
    }
    std::fs::read(path).map_err(|error| format!("{}: {error}", path.display()))
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
    let left_path = resolve_path(context.working_dir, &left);
    let right_path = resolve_path(context.working_dir, &right);
    let working_dir = context.working_dir.to_path_buf();
    let left_label = observation_path_label(&working_dir, &left_path);
    let right_label = observation_path_label(&working_dir, &right_path);
    let result = tokio::task::spawn_blocking(move || {
        let left_bytes = read_text_file_bytes(&left_path)?;
        let right_bytes = read_text_file_bytes(&right_path)?;
        let left_text = utf8_text(&left_bytes, &left_path)?;
        let right_text = utf8_text(&right_bytes, &right_path)?;
        Ok::<_, String>(format_unified_diff(
            &left_label,
            &right_label,
            left_text,
            right_text,
        ))
    })
    .await
    .map_err(|error| ToolOutcome::error(format!("Diff task failed: {error}")))?
    .map_err(ToolOutcome::error)?;
    Ok(ToolOutcome::ok(truncate(result, MAX_TOOL_OUTPUT_CHARS)))
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
        let path = path.to_path_buf();
        let display = path.display().to_string();
        let result = tokio::task::spawn_blocking(move || trash::delete(&path))
            .await
            .map_err(|error| ToolOutcome::error(format!("Trash task failed: {error}")))?;
        if let Err(error) = result {
            return Err(ToolOutcome::error(format!(
                "Trash failed at paths[{index}] '{display}': {error}; {index} item(s) already moved"
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
    let working_dir = context.working_dir.to_path_buf();
    let result = tokio::task::spawn_blocking(move || patch_sync(&patch_text, &working_dir, apply))
        .await
        .map_err(|error| ToolOutcome::error(format!("Patch task failed: {error}")))?
        .map_err(ToolOutcome::error)?;
    Ok(ToolOutcome::ok(result))
}

#[derive(Debug)]
struct PlannedPatch {
    original: Option<Vec<u8>>,
    updated: Option<Vec<u8>>,
}

fn patch_sync(patch_text: &str, working_dir: &Path, should_apply: bool) -> Result<String, String> {
    let patches = split_unified_patches(patch_text)?;
    let mut changes = BTreeMap::<PathBuf, PlannedPatch>::new();

    for patch_text in patches {
        let patch = Patch::from_str(patch_text)
            .map_err(|error| format!("Invalid unified diff: {error}"))?;
        let original_name = patch.original().filter(|path| *path != "/dev/null");
        let modified_name = patch.modified().filter(|path| *path != "/dev/null");
        let source = original_name.map(|path| resolve_path(working_dir, path));
        let target = modified_name.map(|path| resolve_path(working_dir, path));
        let base = if let Some(source) = &source {
            staged_or_disk_text(&changes, source)?
        } else {
            String::new()
        };
        let updated =
            apply(&base, &patch).map_err(|error| format!("Patch validation failed: {error}"))?;

        match (source, target) {
            (None, Some(target)) => {
                if changes.contains_key(&target) || target.exists() {
                    return Err(format!(
                        "{}: create target already exists",
                        target.display()
                    ));
                }
                changes.insert(
                    target,
                    PlannedPatch {
                        original: None,
                        updated: Some(updated.into_bytes()),
                    },
                );
            }
            (Some(source), None) => {
                if !updated.is_empty() {
                    return Err(format!(
                        "{}: delete patch did not produce an empty file",
                        source.display()
                    ));
                }
                let original = original_bytes(&changes, &source)?;
                changes.insert(
                    source,
                    PlannedPatch {
                        original: Some(original),
                        updated: None,
                    },
                );
            }
            (Some(source), Some(target)) if source == target => {
                let original = original_bytes(&changes, &source)?;
                changes.insert(
                    source,
                    PlannedPatch {
                        original: Some(original),
                        updated: Some(updated.into_bytes()),
                    },
                );
            }
            (Some(source), Some(target)) => {
                if changes.contains_key(&target) || target.exists() {
                    return Err(format!("{}: patch target already exists", target.display()));
                }
                let original = original_bytes(&changes, &source)?;
                changes.insert(
                    source,
                    PlannedPatch {
                        original: Some(original),
                        updated: None,
                    },
                );
                changes.insert(
                    target,
                    PlannedPatch {
                        original: None,
                        updated: Some(updated.into_bytes()),
                    },
                );
            }
            (None, None) => return Err("Patch has no source or target path".into()),
        }
    }

    if changes.is_empty() {
        return Err("Patch contains no file changes".into());
    }
    if should_apply {
        apply_planned_changes(&changes)?;
        Ok(format!("Applied patch to {} file(s)", changes.len()))
    } else {
        Ok(format!(
            "Patch valid for {} file(s); no files changed",
            changes.len()
        ))
    }
}

fn split_unified_patches(input: &str) -> Result<Vec<&str>, String> {
    let mut lines = Vec::new();
    let mut offset = 0;
    for line in input.split_inclusive('\n') {
        lines.push((offset, line));
        offset += line.len();
    }
    if offset < input.len() {
        lines.push((offset, &input[offset..]));
    }
    let mut starts = lines
        .windows(3)
        .filter(|group| {
            group[0].1.starts_with("--- ")
                && group[1].1.starts_with("+++ ")
                && group[2].1.starts_with("@@ ")
        })
        .map(|group| group[0].0)
        .collect::<Vec<_>>();
    if starts.is_empty() {
        return Err("Invalid unified diff: missing `---` header".into());
    }
    starts.push(input.len());
    Ok(starts
        .windows(2)
        .map(|range| &input[range[0]..range[1]])
        .collect())
}

fn staged_or_disk_text(
    changes: &BTreeMap<PathBuf, PlannedPatch>,
    path: &Path,
) -> Result<String, String> {
    let bytes = if let Some(change) = changes.get(path) {
        change
            .updated
            .clone()
            .ok_or_else(|| format!("{}: file was already deleted by this patch", path.display()))?
    } else {
        read_text_file_bytes(path)?
    };
    utf8_text(&bytes, path).map(str::to_owned)
}

fn original_bytes(
    changes: &BTreeMap<PathBuf, PlannedPatch>,
    path: &Path,
) -> Result<Vec<u8>, String> {
    if let Some(change) = changes.get(path) {
        return change
            .original
            .clone()
            .ok_or_else(|| format!("{}: file was created earlier in this patch", path.display()));
    }
    read_text_file_bytes(path)
}

fn apply_planned_changes(changes: &BTreeMap<PathBuf, PlannedPatch>) -> Result<(), String> {
    let mut completed = Vec::<&PathBuf>::new();
    for (path, change) in changes {
        let result = match &change.updated {
            Some(bytes) => std::fs::write(path, bytes),
            None => std::fs::remove_file(path),
        };
        if let Err(error) = result {
            for completed_path in completed.into_iter().rev() {
                if let Some(original) = &changes[completed_path].original {
                    let _ = std::fs::write(completed_path, original);
                } else {
                    let _ = std::fs::remove_file(completed_path);
                }
            }
            return Err(format!(
                "{}: {error}; prior writes were rolled back",
                path.display()
            ));
        }
        completed.push(path);
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths_use_forward_slashes() {
        assert_eq!(
            display_relative_path(Path::new("nested").join("written.txt").as_path()),
            "nested/written.txt"
        );
    }

    #[test]
    fn unified_diff_uses_requested_labels_and_hunk_body() {
        let summary =
            format_unified_diff("left.txt", "right.txt", "alpha\nbefore\n", "alpha\nafter\n");
        assert!(
            summary.starts_with("--- left.txt\n+++ right.txt\n@@"),
            "{summary:?}"
        );
        assert!(summary.contains("-before"));
        assert!(summary.contains("+after"));
    }

    #[test]
    fn observation_labels_strip_windows_verbatim_workspace_prefix() {
        let working_dir = PathBuf::from(r"C:\Work\ws");
        let absolute = PathBuf::from(r"\\?\C:\Work\ws\nested\left.txt");
        assert_eq!(
            strip_windows_verbatim_prefix(&absolute),
            PathBuf::from(r"C:\Work\ws\nested\left.txt")
        );
        assert_eq!(
            observation_path_label(&working_dir, &absolute),
            "nested/left.txt"
        );
    }

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
