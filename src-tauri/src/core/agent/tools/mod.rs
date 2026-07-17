//! OS core tools invoked directly by the agent loop.

mod archive;
mod clipboard;
mod fs;
mod git;
mod http;
mod notify;
mod proc;
mod shell;
pub(super) mod tool_view;
mod web;
mod web_extract;
mod web_search;

#[cfg(test)]
mod contract_tests;

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::path_policy::prepare_call_paths;
use super::resource_class::{resource_class_for, ResourceClass};
use super::shell_guard::{evaluate_shell_command, join_command_stream, ShellGuardVerdict};
use super::types::{ApprovalRequest, ApprovalResource, ToolCallPayload, ToolOutcome};

pub const MAX_TOOL_OUTPUT_CHARS: usize = 16_000;

#[async_trait]
pub trait ApprovalHook: Send + Sync {
    async fn request(&self, request: ApprovalRequest) -> Result<bool, String>;
}

#[async_trait]
pub trait DesktopServices: Send + Sync {
    async fn write_clipboard(&self, text: String) -> Result<(), String>;
    async fn notify(&self, title: String, body: String) -> Result<(), String>;
}

pub struct ToolContext<'a> {
    pub working_dir: &'a Path,
    pub approval: &'a dyn ApprovalHook,
    pub cancellation: &'a CancellationToken,
    pub loaded_tools: &'a tool_view::LoadedTools,
    pub desktop: &'a dyn DesktopServices,
}

pub async fn execute(call: &ToolCallPayload, context: &ToolContext<'_>) -> ToolOutcome {
    if context.cancellation.is_cancelled() {
        return ToolOutcome {
            status: super::types::ToolStatus::Cancelled,
            summary: "Tool call cancelled".into(),
            details: None,
        };
    }
    let call = match authorize_call(call, context).await {
        Ok(call) => call,
        Err(outcome) => return outcome,
    };
    let result = match call.tool.as_str() {
        "os.fs.read"
        | "os.fs.read_document"
        | "os.fs.list"
        | "os.fs.glob"
        | "os.fs.grep"
        | "os.fs.hash"
        | "os.fs.diff"
        | "os.fs.write"
        | "os.fs.mkdir"
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
        "os.clipboard.write" => clipboard::write(&call.args, context).await,
        "os.notify" => notify::execute(&call.args, context).await,
        "tool.view" => tool_view::execute(&call.args, context.loaded_tools).await,
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

async fn authorize_call(
    call: &ToolCallPayload,
    context: &ToolContext<'_>,
) -> Result<ToolCallPayload, ToolOutcome> {
    let prepared = prepare_call_paths(call, context.working_dir)
        .await
        .map_err(ToolOutcome::error)?;
    let mut reasons = Vec::new();
    if prepared.call.tool == "os.shell.run" {
        let invocation = shell::parse_invocation(&prepared.call.args)?;
        match evaluate_shell_command(&join_command_stream(
            &invocation.program,
            &invocation.arguments,
        )) {
            ShellGuardVerdict::Allow => {}
            ShellGuardVerdict::ApprovalRequired(reason) => reasons.push(reason),
            ShellGuardVerdict::Block(reason) => {
                return Err(ToolOutcome::denied(reason, "command-blocked"));
            }
        }
    }
    if resource_class_for(&prepared.call.tool) == ResourceClass::ApprovalGated {
        reasons.push("tool is approval-gated".to_string());
    }
    if prepared.escaped_root {
        reasons.push("one or more paths escape the trusted working directory".to_string());
    }
    if reasons.is_empty() {
        return Ok(prepared.call);
    }

    let mut resources = prepared.resources;
    resources.extend(non_path_resources(&prepared.call));
    let request = ApprovalRequest {
        tool: prepared.call.tool.clone(),
        reason: reasons.join("; "),
        preview: safe_preview(&prepared.call),
        affected_resources: resources,
    };
    match context.approval.request(request).await {
        Ok(true) => Ok(prepared.call),
        Ok(false) => Err(ToolOutcome::denied("Approval denied", "approval-required")),
        Err(error) => Err(ToolOutcome::denied(
            format!("Approval failed: {error}"),
            "approval-failed",
        )),
    }
}

fn safe_preview(call: &ToolCallPayload) -> Value {
    let mut preview = serde_json::Map::new();
    let allowed = [
        "path",
        "pathA",
        "pathB",
        "destination",
        "cwd",
        "method",
        "pid",
        "signal",
        "apply",
    ];
    if let Some(args) = call.args.as_object() {
        for key in allowed {
            if let Some(value) = args.get(key) {
                preview.insert(key.into(), value.clone());
            }
        }
    }
    if call.tool == "os.shell.run" {
        let program = call.args.get("cmd").and_then(Value::as_str).unwrap_or("");
        preview.insert(
            "command".into(),
            Value::String(if program.chars().any(char::is_whitespace) {
                "<shell command omitted>".into()
            } else {
                program.into()
            }),
        );
        preview.insert(
            "arguments".into(),
            Value::String("<arguments omitted>".into()),
        );
    }
    if let Some(url) = call.args.get("url").and_then(Value::as_str) {
        preview.insert("url".into(), Value::String(safe_url_preview(url)));
    }
    Value::Object(preview)
}

fn safe_url_preview(raw: &str) -> String {
    let Ok(mut parsed) = url::Url::parse(raw) else {
        return "<invalid URL omitted>".into();
    };
    let _ = parsed.set_username("");
    let _ = parsed.set_password(None);
    parsed.set_query(None);
    parsed.set_fragment(None);
    parsed.to_string()
}

fn non_path_resources(call: &ToolCallPayload) -> Vec<ApprovalResource> {
    match call.tool.as_str() {
        "os.http.request" => call
            .args
            .get("url")
            .and_then(Value::as_str)
            .map(|url| ApprovalResource {
                kind: "url".into(),
                value: safe_url_preview(url),
                operation: call
                    .args
                    .get("method")
                    .and_then(Value::as_str)
                    .unwrap_or("GET")
                    .to_uppercase(),
            })
            .into_iter()
            .collect(),
        "os.proc.kill" => call
            .args
            .get("pid")
            .and_then(Value::as_u64)
            .map(|pid| ApprovalResource {
                kind: "process".into(),
                value: pid.to_string(),
                operation: "terminate".into(),
            })
            .into_iter()
            .collect(),
        _ => Vec::new(),
    }
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

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::core::agent::types::ToolStatus;

    struct TestApproval {
        approved: bool,
        calls: AtomicUsize,
    }

    fn test_dir() -> PathBuf {
        let path = std::env::temp_dir().join(format!("atomic-chat-agent-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[async_trait]
    impl ApprovalHook for TestApproval {
        async fn request(&self, _request: ApprovalRequest) -> Result<bool, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.approved)
        }
    }

    #[derive(Default)]
    struct TestDesktop {
        clipboard_writes: AtomicUsize,
        notifications: AtomicUsize,
    }

    #[async_trait]
    impl DesktopServices for TestDesktop {
        async fn write_clipboard(&self, _text: String) -> Result<(), String> {
            self.clipboard_writes.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        async fn notify(&self, _title: String, _body: String) -> Result<(), String> {
            self.notifications.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    #[tokio::test]
    async fn path_escape_requires_one_call_scoped_approval() {
        let parent = test_dir();
        let root = parent.join("root");
        tokio::fs::create_dir(&root).await.unwrap();
        let outside = parent.join("outside.txt");
        tokio::fs::write(&outside, "secret").await.unwrap();
        let loaded_tools = tool_view::LoadedTools::default();
        let desktop = TestDesktop::default();
        let cancellation = CancellationToken::new();

        for (approved, expected) in [(false, ToolStatus::Denied), (true, ToolStatus::Ok)] {
            let approval = TestApproval {
                approved,
                calls: AtomicUsize::new(0),
            };
            let context = ToolContext {
                working_dir: &root,
                approval: &approval,
                cancellation: &cancellation,
                loaded_tools: &loaded_tools,
                desktop: &desktop,
            };
            let outcome = execute(
                &ToolCallPayload {
                    tool: "os.fs.read".into(),
                    args: serde_json::json!({"path": "../outside.txt"}),
                },
                &context,
            )
            .await;
            assert_eq!(outcome.status, expected);
            assert_eq!(approval.calls.load(Ordering::SeqCst), 1);
        }
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[tokio::test]
    async fn safe_read_inside_root_never_requests_approval() {
        let root = test_dir();
        tokio::fs::write(root.join("inside.txt"), "ok")
            .await
            .unwrap();
        let approval = TestApproval {
            approved: false,
            calls: AtomicUsize::new(0),
        };
        let loaded_tools = tool_view::LoadedTools::default();
        let desktop = TestDesktop::default();
        let cancellation = CancellationToken::new();
        let context = ToolContext {
            working_dir: &root,
            approval: &approval,
            cancellation: &cancellation,
            loaded_tools: &loaded_tools,
            desktop: &desktop,
        };
        let outcome = execute(
            &ToolCallPayload {
                tool: "os.fs.read".into(),
                args: serde_json::json!({"path": "inside.txt"}),
            },
            &context,
        )
        .await;
        assert_eq!(outcome.status, ToolStatus::Ok);
        assert_eq!(approval.calls.load(Ordering::SeqCst), 0);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn desktop_actions_dispatch_without_approval() {
        let root = test_dir();
        let approval = TestApproval {
            approved: false,
            calls: AtomicUsize::new(0),
        };
        let loaded_tools = tool_view::LoadedTools::default();
        let desktop = TestDesktop::default();
        let cancellation = CancellationToken::new();
        let context = ToolContext {
            working_dir: &root,
            approval: &approval,
            cancellation: &cancellation,
            loaded_tools: &loaded_tools,
            desktop: &desktop,
        };

        let clipboard = execute(
            &ToolCallPayload {
                tool: "os.clipboard.write".into(),
                args: serde_json::json!({"text": "copied"}),
            },
            &context,
        )
        .await;
        let notification = execute(
            &ToolCallPayload {
                tool: "os.notify".into(),
                args: serde_json::json!({"title": "Ready", "body": "Done"}),
            },
            &context,
        )
        .await;

        assert_eq!(clipboard.status, ToolStatus::Ok);
        assert_eq!(notification.status, ToolStatus::Ok);
        assert_eq!(desktop.clipboard_writes.load(Ordering::SeqCst), 1);
        assert_eq!(desktop.notifications.load(Ordering::SeqCst), 1);
        assert_eq!(approval.calls.load(Ordering::SeqCst), 0);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn shell_guard_blocks_before_approval_and_gates_safe_commands() {
        let root = test_dir();
        let approval = TestApproval {
            approved: true,
            calls: AtomicUsize::new(0),
        };
        let loaded_tools = tool_view::LoadedTools::default();
        let desktop = TestDesktop::default();
        let cancellation = CancellationToken::new();
        let context = ToolContext {
            working_dir: &root,
            approval: &approval,
            cancellation: &cancellation,
            loaded_tools: &loaded_tools,
            desktop: &desktop,
        };

        let blocked = authorize_call(
            &ToolCallPayload {
                tool: "os.shell.run".into(),
                args: serde_json::json!({"cmd": "echo ready && sudo rm -rf /"}),
            },
            &context,
        )
        .await
        .unwrap_err();
        assert_eq!(blocked.status, ToolStatus::Denied);
        assert_eq!(approval.calls.load(Ordering::SeqCst), 0);

        let allowed = authorize_call(
            &ToolCallPayload {
                tool: "os.shell.run".into(),
                args: serde_json::json!({"cmd": "git", "args": ["status", "--short"]}),
            },
            &context,
        )
        .await;
        assert!(allowed.is_ok());
        assert_eq!(approval.calls.load(Ordering::SeqCst), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn approval_preview_omits_shell_arguments_and_url_credentials() {
        let shell = safe_preview(&ToolCallPayload {
            tool: "os.shell.run".into(),
            args: serde_json::json!({
                "cmd": "curl",
                "args": ["-H", "Authorization: Bearer secret", "https://example.com"]
            }),
        });
        let shell_text = shell.to_string();
        assert!(!shell_text.contains("secret"));
        assert!(shell_text.contains("<arguments omitted>"));

        let http = safe_preview(&ToolCallPayload {
            tool: "os.http.request".into(),
            args: serde_json::json!({
                "url": "https://user:password@example.com/path?token=secret#fragment",
                "method": "GET"
            }),
        });
        assert_eq!(http["url"], "https://example.com/path");
    }
}
