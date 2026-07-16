//! OS core tools invoked directly by the agent loop.

mod archive;
mod clipboard;
mod fs;
mod git;
mod http;
mod proc;
mod shell;
mod web;

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::resource_class::{resource_class_for, ResourceClass};
use super::types::{ToolCallPayload, ToolOutcome};

pub const MAX_TOOL_OUTPUT_CHARS: usize = 16_000;

#[async_trait]
pub trait ApprovalHook: Send + Sync {
    async fn request(&self, call: &ToolCallPayload) -> Result<bool, String>;
}

pub struct DenyApprovalHook;

#[async_trait]
impl ApprovalHook for DenyApprovalHook {
    async fn request(&self, _call: &ToolCallPayload) -> Result<bool, String> {
        Ok(false)
    }
}

pub struct ToolContext<'a> {
    pub working_dir: &'a Path,
    pub approval: &'a dyn ApprovalHook,
    pub cancellation: &'a CancellationToken,
}

pub async fn execute(call: &ToolCallPayload, context: &ToolContext<'_>) -> ToolOutcome {
    if context.cancellation.is_cancelled() {
        return ToolOutcome {
            status: super::types::ToolStatus::Cancelled,
            summary: "Tool call cancelled".into(),
            details: None,
        };
    }
    if resource_class_for(&call.tool) == ResourceClass::ApprovalGated {
        match context.approval.request(call).await {
            Ok(true) => {}
            Ok(false) => return ToolOutcome::denied("Approval denied", "approval-required"),
            Err(error) => {
                return ToolOutcome::denied(format!("Approval failed: {error}"), "approval-failed")
            }
        }
    }
    let result = match call.tool.as_str() {
        "os.fs.read"
        | "os.fs.read_document"
        | "os.fs.list"
        | "os.fs.glob"
        | "os.fs.grep"
        | "os.fs.hash"
        | "os.fs.diff"
        | "os.fs.write"
        | "os.fs.edit"
        | "os.fs.trash"
        | "os.fs.patch" => fs::execute(&call.tool, &call.args, context).await,
        "os.fs.archive.list" | "os.fs.archive.read_entry" | "os.fs.archive.extract" => {
            archive::execute(&call.tool, &call.args, context).await
        }
        tool if tool.starts_with("os.git.") => git::execute(tool, &call.args, context).await,
        "os.shell.run" => shell::execute(&call.args, context).await,
        "os.proc.list" | "os.proc.kill" => proc::execute(&call.tool, &call.args, context).await,
        "os.http.request" => http::execute(&call.args, context).await,
        "os.web.search" | "os.web.fetch" => web::execute(&call.tool, &call.args, context).await,
        "os.clipboard.read" => clipboard::read(context).await,
        "reply" => required_string(&call.args, "text")
            .map(ToolOutcome::ok)
            .map_err(ToolOutcome::error),
        "finish" => required_string(&call.args, "summary")
            .map(ToolOutcome::ok)
            .map_err(ToolOutcome::error),
        _ => Err(ToolOutcome::error(format!("Unknown tool: {}", call.tool))),
    };
    result.unwrap_or_else(|outcome| outcome)
}

pub(super) fn resolve_path(working_dir: &Path, value: &str) -> PathBuf {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        path
    } else {
        working_dir.join(path)
    }
}

pub(super) fn required_string(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Missing non-empty string argument `{key}`"))
}

pub(super) fn optional_usize(args: &Value, key: &str, default: usize, max: usize) -> usize {
    args.get(key)
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(default)
        .min(max)
}

pub(super) fn truncate(mut value: String, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value;
    }
    value = value.chars().take(max_chars).collect();
    value.push_str("\n[truncated]");
    value
}

pub(super) fn command_outcome(output: std::process::Output) -> Result<ToolOutcome, ToolOutcome> {
    let stdout = truncate(
        String::from_utf8_lossy(&output.stdout).trim().to_owned(),
        MAX_TOOL_OUTPUT_CHARS,
    );
    let stderr = truncate(
        String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        MAX_TOOL_OUTPUT_CHARS,
    );
    if output.status.success() {
        Ok(ToolOutcome {
            status: super::types::ToolStatus::Ok,
            summary: if stdout.is_empty() {
                "Command completed".into()
            } else {
                stdout
            },
            details: Some(serde_json::json!({"exitCode": output.status.code()})),
        })
    } else {
        Err(ToolOutcome {
            status: super::types::ToolStatus::Error,
            summary: if stderr.is_empty() {
                format!("Command exited with {}", output.status)
            } else {
                stderr
            },
            details: Some(serde_json::json!({"exitCode": output.status.code()})),
        })
    }
}
