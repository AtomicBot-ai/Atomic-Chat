use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use flate2::read::GzDecoder;
use serde_json::Value;

use super::{required_string, resolve_path, truncate, ToolContext, MAX_TOOL_OUTPUT_CHARS};
use crate::core::agent::types::ToolOutcome;

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
                &required_string(args, "destination").map_err(ToolOutcome::error)?,
            );
            run_blocking(move || extract_archive(&archive, &destination)).await
        }
        _ => Err(ToolOutcome::error(format!(
            "Unsupported archive tool: {tool}"
        ))),
    }
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

fn extract_archive(path: &Path, destination: &Path) -> Result<ToolOutcome, ToolOutcome> {
    std::fs::create_dir_all(destination).map_err(io_error)?;
    if is_zip(path) {
        let file = File::open(path).map_err(io_error)?;
        let mut archive = zip::ZipArchive::new(file).map_err(io_error)?;
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).map_err(io_error)?;
            let enclosed = entry
                .enclosed_name()
                .ok_or_else(|| ToolOutcome::error("Archive contains an unsafe path"))?
                .to_owned();
            let output = destination.join(enclosed);
            if entry.is_dir() {
                std::fs::create_dir_all(&output).map_err(io_error)?;
                continue;
            }
            if let Some(parent) = output.parent() {
                std::fs::create_dir_all(parent).map_err(io_error)?;
            }
            let mut file = File::create(&output).map_err(io_error)?;
            std::io::copy(&mut entry, &mut file).map_err(io_error)?;
        }
    } else {
        let mut archive = open_tar(path)?;
        for entry in archive.entries().map_err(io_error)? {
            let mut entry = entry.map_err(io_error)?;
            entry
                .unpack_in(destination)
                .map_err(io_error)
                .and_then(|safe| {
                    safe.then_some(())
                        .ok_or_else(|| ToolOutcome::error("Archive contains an unsafe path"))
                })?;
        }
    }
    Ok(ToolOutcome::ok(format!(
        "Extracted {} to {}",
        path.display(),
        destination.display()
    )))
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
