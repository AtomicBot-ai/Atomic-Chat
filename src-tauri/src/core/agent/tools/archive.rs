use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use flate2::read::GzDecoder;
use serde_json::Value;

use super::{required_string, resolve_path, truncate, ToolContext, MAX_TOOL_OUTPUT_CHARS};
use crate::core::agent::types::{ToolOutcome, ToolStatus};

pub(super) const MAX_EXTRACT_ENTRIES: usize = 10_000;
pub(super) const MAX_EXTRACT_ENTRY_BYTES: u64 = 512 * 1024 * 1024;
pub(super) const MAX_EXTRACT_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;

pub async fn execute(
    tool: &str,
    args: &Value,
    context: &ToolContext<'_>,
) -> Result<ToolOutcome, ToolOutcome> {
    let archive = resolve_path(
        context.working_dir,
        &required_string(args, "path").map_err(ToolOutcome::error)?,
    );
    match tool {
        "os.fs.archive.list" => run_blocking(move || list_archive(&archive)).await,
        "os.fs.archive.read_entry" => {
            let entry = required_string(args, "entry").map_err(ToolOutcome::error)?;
            run_blocking(move || read_entry(&archive, &entry)).await
        }
        "os.fs.archive.extract" => {
            let destination = resolve_path(
                context.working_dir,
                &extract_destination(args).map_err(ToolOutcome::error)?,
            );
            let overwrite = args
                .get("overwrite")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            run_blocking(move || extract_archive(&archive, &destination, overwrite)).await
        }
        _ => Err(ToolOutcome::error(format!(
            "Unsupported archive tool: {tool}"
        ))),
    }
}

fn extract_destination(args: &Value) -> Result<String, String> {
    required_string(args, "destination").or_else(|_| required_string(args, "dest"))
}

async fn run_blocking(
    operation: impl FnOnce() -> Result<ToolOutcome, ToolOutcome> + Send + 'static,
) -> Result<ToolOutcome, ToolOutcome> {
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| ToolOutcome::error(error.to_string()))?
}

fn list_archive(path: &Path) -> Result<ToolOutcome, ToolOutcome> {
    if is_zip(path) {
        let file = File::open(path).map_err(io_error)?;
        let mut archive = zip::ZipArchive::new(file).map_err(io_error)?;
        let mut rows = Vec::with_capacity(archive.len());
        for index in 0..archive.len() {
            let entry = archive.by_index(index).map_err(io_error)?;
            rows.push(format!("{}\t{}", entry.size(), entry.name()));
        }
        return Ok(ToolOutcome::ok(truncate(
            rows.join("\n"),
            MAX_TOOL_OUTPUT_CHARS,
        )));
    }
    let mut archive = open_tar(path)?;
    let mut rows = Vec::new();
    for entry in archive.entries().map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        rows.push(format!(
            "{}\t{}",
            entry.size(),
            entry.path().map_err(io_error)?.display()
        ));
    }
    Ok(ToolOutcome::ok(truncate(
        rows.join("\n"),
        MAX_TOOL_OUTPUT_CHARS,
    )))
}

fn read_entry(path: &Path, requested: &str) -> Result<ToolOutcome, ToolOutcome> {
    if is_zip(path) {
        let file = File::open(path).map_err(io_error)?;
        let mut archive = zip::ZipArchive::new(file).map_err(io_error)?;
        let mut entry = archive.by_name(requested).map_err(io_error)?;
        if entry.is_dir() {
            return Err(ToolOutcome::error("Archive entry is a directory"));
        }
        return read_limited(&mut entry);
    }
    let mut archive = open_tar(path)?;
    for entry in archive.entries().map_err(io_error)? {
        let mut entry = entry.map_err(io_error)?;
        if entry.path().map_err(io_error)? == PathBuf::from(requested) {
            return read_limited(&mut entry);
        }
    }
    Err(ToolOutcome::error(format!(
        "Archive entry not found: {requested}"
    )))
}

fn extract_archive(
    path: &Path,
    destination: &Path,
    overwrite: bool,
) -> Result<ToolOutcome, ToolOutcome> {
    validate_destination(destination)?;
    let (entries, total_bytes) = if is_zip(path) {
        let file = File::open(path).map_err(io_error)?;
        let mut archive = zip::ZipArchive::new(file).map_err(io_error)?;
        let plans = validate_zip_entries(&mut archive, destination, overwrite)?;
        let total_bytes: u64 = plans.iter().map(|entry| entry.size).sum();
        std::fs::create_dir_all(destination).map_err(io_error)?;
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).map_err(io_error)?;
            let plan = &plans[index];
            if plan.is_dir {
                std::fs::create_dir_all(&plan.output).map_err(io_error)?;
                continue;
            }
            if let Some(parent) = plan.output.parent() {
                std::fs::create_dir_all(parent).map_err(io_error)?;
            }
            let mut file = File::create(&plan.output).map_err(io_error)?;
            copy_limited(&mut entry, &mut file, plan.size)?;
            file.flush().map_err(io_error)?;
        }
        (plans.len(), total_bytes)
    } else {
        let plans = validate_tar_entries(path, destination, overwrite)?;
        let total_bytes: u64 = plans.iter().map(|entry| entry.size).sum();
        std::fs::create_dir_all(destination).map_err(io_error)?;
        let mut archive = open_tar(path)?;
        for (entry, plan) in archive.entries().map_err(io_error)?.zip(plans.iter()) {
            let mut entry = entry.map_err(io_error)?;
            if plan.is_dir {
                std::fs::create_dir_all(&plan.output).map_err(io_error)?;
                continue;
            }
            if let Some(parent) = plan.output.parent() {
                std::fs::create_dir_all(parent).map_err(io_error)?;
            }
            let mut file = File::create(&plan.output).map_err(io_error)?;
            copy_limited(&mut entry, &mut file, plan.size)?;
            file.flush().map_err(io_error)?;
        }
        (plans.len(), total_bytes)
    };
    Ok(ToolOutcome {
        status: ToolStatus::Ok,
        summary: format!("Extracted {} to {}", path.display(), destination.display()),
        details: Some(serde_json::json!({
            "source": path,
            "destination": destination,
            "overwrite": overwrite,
            "entries": entries,
            "bytesExtracted": total_bytes,
            "limits": {
                "maxEntries": MAX_EXTRACT_ENTRIES,
                "maxEntryBytes": MAX_EXTRACT_ENTRY_BYTES,
                "maxTotalBytes": MAX_EXTRACT_TOTAL_BYTES,
            },
        })),
    })
}

#[derive(Debug)]
struct ExtractPlan {
    output: PathBuf,
    size: u64,
    is_dir: bool,
}

fn validate_zip_entries(
    archive: &mut zip::ZipArchive<File>,
    destination: &Path,
    overwrite: bool,
) -> Result<Vec<ExtractPlan>, ToolOutcome> {
    validate_entry_count(archive.len())?;
    let mut plans = Vec::with_capacity(archive.len());
    let mut total = 0_u64;
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(io_error)?;
        let enclosed = entry
            .enclosed_name()
            .ok_or_else(|| ToolOutcome::error("Archive contains an unsafe path"))?
            .to_owned();
        let is_dir = entry.is_dir();
        if let Some(mode) = entry.unix_mode() {
            let file_type = mode & 0o170000;
            if file_type != 0 && file_type != 0o100000 && file_type != 0o040000 {
                return Err(ToolOutcome::error(format!(
                    "Archive entry '{}' is not a regular file or directory",
                    entry.name()
                )));
            }
        }
        validate_size(entry.size(), &mut total, entry.name())?;
        let output = destination.join(enclosed);
        validate_output_target(&output, destination, overwrite, is_dir)?;
        plans.push(ExtractPlan {
            output,
            size: entry.size(),
            is_dir,
        });
    }
    validate_plan_conflicts(&plans)?;
    Ok(plans)
}

fn validate_tar_entries(
    path: &Path,
    destination: &Path,
    overwrite: bool,
) -> Result<Vec<ExtractPlan>, ToolOutcome> {
    let mut archive = open_tar(path)?;
    let mut plans = Vec::new();
    let mut total = 0_u64;
    for entry in archive.entries().map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        if plans.len() >= MAX_EXTRACT_ENTRIES {
            return Err(ToolOutcome::error(format!(
                "Archive exceeds the {MAX_EXTRACT_ENTRIES}-entry limit"
            )));
        }
        let entry_type = entry.header().entry_type();
        if !entry_type.is_file() && !entry_type.is_dir() {
            return Err(ToolOutcome::error(format!(
                "Archive entry '{}' is not a regular file or directory",
                entry.path().map_err(io_error)?.display()
            )));
        }
        let relative = entry.path().map_err(io_error)?.into_owned();
        if relative.is_absolute()
            || relative
                .components()
                .any(|component| matches!(component, std::path::Component::ParentDir))
        {
            return Err(ToolOutcome::error("Archive contains an unsafe path"));
        }
        let size = entry.size();
        validate_size(size, &mut total, &relative.to_string_lossy())?;
        let output = destination.join(relative);
        validate_output_target(&output, destination, overwrite, entry_type.is_dir())?;
        plans.push(ExtractPlan {
            output,
            size,
            is_dir: entry_type.is_dir(),
        });
    }
    validate_plan_conflicts(&plans)?;
    Ok(plans)
}

fn validate_destination(destination: &Path) -> Result<(), ToolOutcome> {
    if let Ok(metadata) = std::fs::symlink_metadata(destination) {
        if metadata.file_type().is_symlink() {
            return Err(ToolOutcome::error(format!(
                "Archive destination '{}' is a symlink",
                destination.display()
            )));
        }
        if !metadata.is_dir() {
            return Err(ToolOutcome::error(format!(
                "Archive destination '{}' is not a directory",
                destination.display()
            )));
        }
    }
    Ok(())
}

fn validate_plan_conflicts(plans: &[ExtractPlan]) -> Result<(), ToolOutcome> {
    for (index, plan) in plans.iter().enumerate() {
        if plans[..index]
            .iter()
            .any(|previous| previous.output == plan.output)
        {
            return Err(ToolOutcome::error(format!(
                "Archive contains duplicate output '{}'",
                plan.output.display()
            )));
        }
        if plans.iter().any(|parent| {
            !parent.is_dir
                && parent.output != plan.output
                && plan.output.starts_with(&parent.output)
        }) {
            return Err(ToolOutcome::error(format!(
                "Archive output '{}' has a file as its parent",
                plan.output.display()
            )));
        }
    }
    Ok(())
}

fn validate_entry_count(count: usize) -> Result<(), ToolOutcome> {
    if count > MAX_EXTRACT_ENTRIES {
        return Err(ToolOutcome::error(format!(
            "Archive exceeds the {MAX_EXTRACT_ENTRIES}-entry limit"
        )));
    }
    Ok(())
}

fn validate_size(size: u64, total: &mut u64, name: &str) -> Result<(), ToolOutcome> {
    if size > MAX_EXTRACT_ENTRY_BYTES {
        return Err(ToolOutcome::error(format!(
            "Archive entry '{name}' exceeds the {MAX_EXTRACT_ENTRY_BYTES}-byte limit"
        )));
    }
    *total = total
        .checked_add(size)
        .ok_or_else(|| ToolOutcome::error("Archive expanded size overflowed"))?;
    if *total > MAX_EXTRACT_TOTAL_BYTES {
        return Err(ToolOutcome::error(format!(
            "Archive exceeds the {MAX_EXTRACT_TOTAL_BYTES}-byte expanded-size limit"
        )));
    }
    Ok(())
}

fn validate_output_target(
    output: &Path,
    destination: &Path,
    overwrite: bool,
    is_dir: bool,
) -> Result<(), ToolOutcome> {
    if !output.starts_with(destination) {
        return Err(ToolOutcome::error("Archive contains an unsafe path"));
    }
    let mut current = output.parent();
    while let Some(parent) = current {
        if parent == destination {
            break;
        }
        if let Ok(metadata) = std::fs::symlink_metadata(parent) {
            if metadata.file_type().is_symlink() {
                return Err(ToolOutcome::error(format!(
                    "Archive output parent '{}' is a symlink",
                    parent.display()
                )));
            }
            if !metadata.is_dir() {
                return Err(ToolOutcome::error(format!(
                    "Archive output parent '{}' is not a directory",
                    parent.display()
                )));
            }
        }
        current = parent.parent();
    }
    if let Ok(metadata) = std::fs::symlink_metadata(output) {
        if metadata.file_type().is_symlink() {
            return Err(ToolOutcome::error(format!(
                "Archive output '{}' is a symlink",
                output.display()
            )));
        }
        if !overwrite && !(is_dir && metadata.is_dir()) {
            return Err(ToolOutcome::error(format!(
                "Archive output '{}' already exists; set overwrite=true to replace it",
                output.display()
            )));
        }
        if is_dir != metadata.is_dir() {
            return Err(ToolOutcome::error(format!(
                "Archive output '{}' has an incompatible existing type",
                output.display()
            )));
        }
    }
    Ok(())
}

fn copy_limited(
    reader: &mut impl Read,
    writer: &mut impl Write,
    expected_size: u64,
) -> Result<(), ToolOutcome> {
    let copied = std::io::copy(&mut reader.take(expected_size.saturating_add(1)), writer)
        .map_err(io_error)?;
    if copied != expected_size {
        return Err(ToolOutcome::error(format!(
            "Archive entry size mismatch: expected {expected_size} bytes, extracted {copied}"
        )));
    }
    Ok(())
}

fn open_tar(path: &Path) -> Result<tar::Archive<Box<dyn Read>>, ToolOutcome> {
    let file = File::open(path).map_err(io_error)?;
    let reader: Box<dyn Read> = if is_gzip(path) {
        Box::new(GzDecoder::new(file))
    } else {
        Box::new(file)
    };
    Ok(tar::Archive::new(reader))
}

fn read_limited(reader: &mut impl Read) -> Result<ToolOutcome, ToolOutcome> {
    let mut bytes = Vec::new();
    reader
        .take((MAX_TOOL_OUTPUT_CHARS + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    let text = String::from_utf8(bytes)
        .map_err(|_| ToolOutcome::error("Archive entry is not UTF-8 text"))?;
    Ok(ToolOutcome::ok(truncate(text, MAX_TOOL_OUTPUT_CHARS)))
}

fn is_zip(path: &Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
}

fn is_gzip(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    name.ends_with(".tar.gz") || name.ends_with(".tgz")
}

fn io_error(error: impl std::fmt::Display) -> ToolOutcome {
    ToolOutcome::error(error.to_string())
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    #[test]
    fn extract_destination_prefers_canonical_field() {
        let args = serde_json::json!({
            "destination": "canonical",
            "dest": "legacy"
        });
        assert_eq!(extract_destination(&args).unwrap(), "canonical");
    }

    #[test]
    fn extract_destination_accepts_legacy_alias() {
        let args = serde_json::json!({"dest": "legacy"});
        assert_eq!(extract_destination(&args).unwrap(), "legacy");
    }

    #[test]
    fn extract_destination_rejects_missing_value() {
        assert!(extract_destination(&serde_json::json!({})).is_err());
    }

    #[test]
    fn extraction_limits_reject_entry_and_total_bombs() {
        let mut entry_total = 0;
        assert!(validate_size(MAX_EXTRACT_ENTRY_BYTES + 1, &mut entry_total, "large.bin").is_err());
        let mut archive_total = MAX_EXTRACT_TOTAL_BYTES;
        assert!(validate_size(1, &mut archive_total, "overflow.bin").is_err());
        assert!(validate_entry_count(MAX_EXTRACT_ENTRIES + 1).is_err());
    }

    #[test]
    fn tar_validation_rejects_symlink_entries() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("symlink.tar");
        let file = File::create(&path).unwrap();
        let mut builder = tar::Builder::new(file);
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_size(0);
        header.set_mode(0o777);
        header.set_link_name("target").unwrap();
        header.set_cksum();
        builder
            .append_data(&mut header, "link", Cursor::new(Vec::<u8>::new()))
            .unwrap();
        builder.finish().unwrap();

        let destination = temp.path().join("out");
        let error = validate_tar_entries(&path, &destination, false).unwrap_err();
        assert!(error.summary.contains("not a regular file or directory"));
    }

    #[test]
    fn output_validation_rejects_non_directory_parent() {
        let temp = tempfile::tempdir().unwrap();
        let destination = temp.path().join("out");
        std::fs::create_dir(&destination).unwrap();
        std::fs::write(destination.join("parent"), b"file").unwrap();
        let output = destination.join("parent/child.txt");
        let error = validate_output_target(&output, &destination, true, false).unwrap_err();
        assert!(error.summary.contains("is not a directory"));
    }
}
