//! OS core tools invoked directly by the agent loop.

mod archive;
mod clipboard;
mod fs;
mod git;
mod http;
mod notify;
mod proc;
mod shell;
mod skill_run_script;
mod skill_view;
pub(super) mod tool_view;
mod vision;
mod web;
mod web_exa;
mod web_extract;
mod web_search;

#[cfg(test)]
mod contract_tests;

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::approval_allowlist::fingerprint_prepared_action;
use super::llm_client::LlamaServerClient;
use super::path_policy::{prepare_call_paths, EditableRoots};
use super::resource_class::{resource_class_for, ResourceClass};
use super::shell_guard::{evaluate_shell_command, join_command_stream, ShellGuardVerdict};
use super::skills::{loaded::LoadedSkills, SkillRegistry};
use super::types::{
    ApprovalDecision, ApprovalRequest, ApprovalResource, FolderAccessRequest, ToolCallPayload,
    ToolOutcome,
};

pub const MAX_TOOL_OUTPUT_CHARS: usize = 16_000;

#[async_trait]
pub trait ApprovalHook: Send + Sync {
    async fn is_allowed(&self, fingerprint: &str) -> bool;
    async fn request(&self, request: ApprovalRequest) -> Result<ApprovalDecision, String>;
}

#[async_trait]
pub trait FolderAccessHook: Send + Sync {
    async fn request(&self, request: FolderAccessRequest) -> Result<bool, String>;
}

#[async_trait]
pub trait DesktopServices: Send + Sync {
    async fn write_clipboard(&self, text: String) -> Result<(), String>;
    async fn notify(&self, title: String, body: String) -> Result<(), String>;
}

pub struct ToolContext<'a> {
    pub working_dir: &'a Path,
    pub editable_roots: &'a EditableRoots,
    pub trusted_read_roots: &'a [PathBuf],
    pub client: Option<&'a LlamaServerClient>,
    pub approval: &'a dyn ApprovalHook,
    pub folder_access: &'a dyn FolderAccessHook,
    pub cancellation: &'a CancellationToken,
    pub loaded_tools: &'a tool_view::LoadedTools,
    pub loaded_skills: &'a LoadedSkills,
    pub skill_registry: &'a SkillRegistry,
    pub bundled_script_runtime: Option<&'a Path>,
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
    if call.tool == "os.proc.kill" {
        if let Err(error) = proc::validate_kill_args(&call.args) {
            return ToolOutcome::error(error);
        }
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
        "vision.describe" => vision::describe(&call.args, context).await,
        "skill.run_script" => skill_run_script::execute(&call.args, context).await,
        "skill.view" => skill_view::execute(&call.args, context).await,
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
    let mut prepared = prepare_call_paths(
        call,
        context.working_dir,
        context.editable_roots,
        context.trusted_read_roots,
    )
    .await
    .map_err(ToolOutcome::error)?;
    while let Some(folder_request) = prepared.folder_access.clone() {
        let allowed = context
            .folder_access
            .request(folder_request.clone())
            .await
            .map_err(ToolOutcome::error)?;
        if !allowed {
            return Err(ToolOutcome::denied(
                format!("Folder access denied for {}", folder_request.path),
                "folder-access-denied",
            ));
        }
        context
            .editable_roots
            .add(Path::new(&folder_request.path))
            .await
            .map_err(ToolOutcome::error)?;
        prepared = prepare_call_paths(
            call,
            context.working_dir,
            context.editable_roots,
            context.trusted_read_roots,
        )
        .await
        .map_err(ToolOutcome::error)?;
    }
    let mut reasons = Vec::new();
    let mut skill_invocation = None;
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
    if prepared.call.tool == "skill.run_script" {
        let invocation = skill_run_script::prepare(
            &prepared.call.args,
            context.skill_registry,
            context.bundled_script_runtime,
        )
        .await?;
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
        skill_invocation = Some(invocation);
    }
    let is_approval_gated = resource_class_for(&prepared.call.tool) == ResourceClass::ApprovalGated;
    if is_approval_gated {
        reasons.push("tool is approval-gated".to_string());
    }
    if prepared.escaped_root {
        reasons.push("one or more paths escape the connected workspace roots".to_string());
    }
    if reasons.is_empty() {
        return Ok(prepared.call);
    }
    let fingerprint = fingerprint_prepared_action(&prepared.call.tool, &prepared.call.args);
    let can_remember = is_approval_gated && !prepared.escaped_root;
    if can_remember && context.approval.is_allowed(&fingerprint).await {
        return Ok(prepared.call);
    }

    let mut resources = prepared.resources;
    resources.extend(non_path_resources(&prepared.call));
    if let Some(invocation) = skill_invocation {
        resources.push(ApprovalResource {
            kind: "skill".into(),
            value: invocation.skill_name,
            operation: "run_script".into(),
        });
        resources.push(ApprovalResource {
            kind: "file".into(),
            value: invocation.script_path.display().to_string(),
            operation: "execute".into(),
        });
    }
    let request = ApprovalRequest {
        tool: prepared.call.tool.clone(),
        reason: reasons.join("; "),
        preview: safe_preview(&prepared.call),
        affected_resources: resources,
        fingerprint,
        can_remember,
    };
    match context.approval.request(request).await {
        Ok(decision) if decision.is_approved() => Ok(prepared.call),
        Ok(ApprovalDecision::Deny) => {
            Err(ToolOutcome::denied("Approval denied", "approval-required"))
        }
        Ok(_) => Err(ToolOutcome::denied(
            "Approval decision is not permitted",
            "approval-required",
        )),
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
        "skill",
        "script",
        "timeout_ms",
    ];
    if let Some(args) = call.args.as_object() {
        for key in allowed {
            if let Some(value) = args.get(key) {
                preview.insert(key.into(), value.clone());
            }
        }
    }
    match call.tool.as_str() {
        "os.fs.trash" => {
            let paths = call
                .args
                .get("paths")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            preview.insert("count".into(), Value::from(paths.len()));
            preview.insert("paths".into(), Value::Array(paths));
        }
        "os.fs.write" => {
            let mode = call
                .args
                .get("mode")
                .and_then(Value::as_str)
                .unwrap_or("replace");
            let byte_count = call
                .args
                .get("content")
                .and_then(Value::as_str)
                .map(str::len)
                .unwrap_or(0);
            preview.insert("mode".into(), Value::String(mode.into()));
            preview.insert("byte_count".into(), Value::from(byte_count));
        }
        "os.fs.edit" => {
            preview.insert(
                "replaceAll".into(),
                Value::Bool(
                    call.args
                        .get("replaceAll")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                ),
            );
        }
        "os.fs.archive.extract" => {
            preview.insert(
                "overwrite".into(),
                Value::Bool(
                    call.args
                        .get("overwrite")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                ),
            );
            preview.insert(
                "limits".into(),
                serde_json::json!({
                    "maxEntries": archive::MAX_EXTRACT_ENTRIES,
                    "maxEntryBytes": archive::MAX_EXTRACT_ENTRY_BYTES,
                    "maxTotalBytes": archive::MAX_EXTRACT_TOTAL_BYTES,
                }),
            );
        }
        "os.fs.patch" => {
            let targets = call
                .args
                .get("patch_paths")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            preview.insert("targets".into(), Value::Array(targets));
        }
        _ => {}
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
    if call.tool == "skill.run_script" {
        const MAX_PREVIEW_ARGUMENTS: usize = 16;
        let values = call
            .args
            .get("args")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let mut arguments = values
            .iter()
            .take(MAX_PREVIEW_ARGUMENTS)
            .filter_map(Value::as_str)
            .map(safe_script_argument_preview)
            .map(Value::String)
            .collect::<Vec<_>>();
        let omitted = values.len().saturating_sub(MAX_PREVIEW_ARGUMENTS);
        if omitted > 0 {
            arguments.push(Value::String(format!(
                "<{omitted} additional arguments omitted>"
            )));
        }
        preview.insert("argument_count".into(), Value::from(values.len()));
        preview.insert("args".into(), Value::Array(arguments));
    }
    if let Some(url) = call.args.get("url").and_then(Value::as_str) {
        preview.insert("url".into(), Value::String(safe_url_preview(url)));
    }
    Value::Object(preview)
}

fn safe_script_argument_preview(raw: &str) -> String {
    const MAX_ARGUMENT_CHARS: usize = 256;
    if raw.starts_with("http://") || raw.starts_with("https://") {
        return safe_url_preview(raw);
    }
    let lower = raw.to_ascii_lowercase();
    if [
        "authorization",
        "bearer ",
        "api_key",
        "apikey",
        "password",
        "token=",
        "secret=",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
        || lower.starts_with("hf_")
    {
        return "<redacted>".into();
    }
    truncate(raw.to_owned(), MAX_ARGUMENT_CHARS)
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
        .filter(|value| *value > 0)
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
    use std::collections::BTreeSet;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex as StdMutex;

    use super::*;
    use crate::core::agent::types::ToolStatus;

    #[test]
    fn optional_usize_uses_default_for_zero_and_caps_large_values() {
        assert_eq!(
            optional_usize(&serde_json::json!({"limit": 0}), "limit", 10, 100),
            10
        );
        assert_eq!(
            optional_usize(&serde_json::json!({"limit": 200}), "limit", 10, 100),
            100
        );
    }

    struct TestApproval {
        approved: bool,
        calls: AtomicUsize,
    }

    struct TestFolderAccess {
        allowed: bool,
        calls: AtomicUsize,
    }

    #[async_trait]
    impl FolderAccessHook for TestFolderAccess {
        async fn request(&self, _request: FolderAccessRequest) -> Result<bool, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.allowed)
        }
    }

    #[derive(Default)]
    struct RememberingApproval {
        allowed: StdMutex<BTreeSet<String>>,
        requests: StdMutex<Vec<ApprovalRequest>>,
    }

    #[async_trait]
    impl ApprovalHook for RememberingApproval {
        async fn is_allowed(&self, fingerprint: &str) -> bool {
            self.allowed.lock().unwrap().contains(fingerprint)
        }

        async fn request(&self, request: ApprovalRequest) -> Result<ApprovalDecision, String> {
            self.requests.lock().unwrap().push(request);
            Ok(ApprovalDecision::AllowOnce)
        }
    }

    fn test_dir() -> PathBuf {
        let path = std::env::temp_dir().join(format!("atomic-chat-agent-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn test_skill_registry(root: &Path) -> SkillRegistry {
        SkillRegistry::load(
            root.join(".agent-skills"),
            &std::collections::BTreeSet::new(),
            &std::collections::BTreeSet::new(),
        )
        .unwrap()
    }

    fn test_script_skill_registry(root: &Path) -> SkillRegistry {
        let skills_root = root.join(".agent-skills");
        let skill_root = skills_root.join("test-skill");
        std::fs::create_dir_all(skill_root.join("scripts")).unwrap();
        std::fs::write(skill_root.join("scripts/inspect.sh"), "echo ready").unwrap();
        std::fs::write(
            skill_root.join("SKILL.md"),
            "---\nname: test-skill\ndescription: Test\nrequires_scripts: [inspect.sh]\n---\nBody",
        )
        .unwrap();
        SkillRegistry::load(
            skills_root,
            &std::collections::BTreeSet::new(),
            &std::collections::BTreeSet::new(),
        )
        .unwrap()
    }

    #[async_trait]
    impl ApprovalHook for TestApproval {
        async fn is_allowed(&self, _fingerprint: &str) -> bool {
            false
        }

        async fn request(&self, _request: ApprovalRequest) -> Result<ApprovalDecision, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(if self.approved {
                ApprovalDecision::AllowOnce
            } else {
                ApprovalDecision::Deny
            })
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
    async fn path_escape_requires_one_call_scoped_folder_access() {
        let parent = test_dir();
        let root = parent.join("root");
        tokio::fs::create_dir(&root).await.unwrap();
        let outside = parent.join("outside.txt");
        tokio::fs::write(&outside, "secret").await.unwrap();
        let loaded_tools = tool_view::LoadedTools::default();
        let loaded_skills = LoadedSkills::default();
        let skill_registry = test_skill_registry(&root);
        let desktop = TestDesktop::default();
        let cancellation = CancellationToken::new();
        let editable_roots = EditableRoots::for_test(&root);

        for (approved, expected) in [(false, ToolStatus::Denied), (true, ToolStatus::Ok)] {
            let approval = TestApproval {
                approved,
                calls: AtomicUsize::new(0),
            };
            let folder_access = TestFolderAccess {
                allowed: approved,
                calls: AtomicUsize::new(0),
            };
            let context = ToolContext {
                working_dir: &root,
                editable_roots: &editable_roots,
                trusted_read_roots: &[],
                client: None,
                approval: &approval,
                folder_access: &folder_access,
                cancellation: &cancellation,
                loaded_tools: &loaded_tools,
                loaded_skills: &loaded_skills,
                skill_registry: &skill_registry,
                bundled_script_runtime: None,
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
            assert_eq!(approval.calls.load(Ordering::SeqCst), 0);
            assert_eq!(folder_access.calls.load(Ordering::SeqCst), 1);
        }
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[tokio::test]
    async fn one_call_can_connect_two_external_roots() {
        let parent = test_dir();
        let root = parent.join("root");
        let external_a = parent.join("external-a");
        let external_b = parent.join("external-b");
        tokio::fs::create_dir(&root).await.unwrap();
        tokio::fs::create_dir(&external_a).await.unwrap();
        tokio::fs::create_dir(&external_b).await.unwrap();
        tokio::fs::write(external_a.join("one.txt"), "one")
            .await
            .unwrap();
        tokio::fs::write(external_b.join("two.txt"), "two")
            .await
            .unwrap();
        let approval = TestApproval {
            approved: false,
            calls: AtomicUsize::new(0),
        };
        let folder_access = TestFolderAccess {
            allowed: true,
            calls: AtomicUsize::new(0),
        };
        let editable_roots = EditableRoots::for_test(&root);
        let loaded_tools = tool_view::LoadedTools::default();
        let loaded_skills = LoadedSkills::default();
        let skill_registry = test_skill_registry(&root);
        let desktop = TestDesktop::default();
        let cancellation = CancellationToken::new();
        let context = ToolContext {
            working_dir: &root,
            editable_roots: &editable_roots,
            trusted_read_roots: &[],
            client: None,
            approval: &approval,
            folder_access: &folder_access,
            cancellation: &cancellation,
            loaded_tools: &loaded_tools,
            loaded_skills: &loaded_skills,
            skill_registry: &skill_registry,
            bundled_script_runtime: None,
            desktop: &desktop,
        };

        let outcome = execute(
            &ToolCallPayload {
                tool: "os.fs.diff".into(),
                args: serde_json::json!({
                    "pathA": external_a.join("one.txt"),
                    "pathB": external_b.join("two.txt"),
                }),
            },
            &context,
        )
        .await;

        assert_eq!(outcome.status, ToolStatus::Ok);
        assert_eq!(folder_access.calls.load(Ordering::SeqCst), 2);
        assert_eq!(approval.calls.load(Ordering::SeqCst), 0);
        assert_eq!(editable_roots.snapshot().await.len(), 3);
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
        let loaded_skills = LoadedSkills::default();
        let skill_registry = test_skill_registry(&root);
        let desktop = TestDesktop::default();
        let cancellation = CancellationToken::new();
        let editable_roots = EditableRoots::for_test(&root);
        let folder_access = TestFolderAccess {
            allowed: false,
            calls: AtomicUsize::new(0),
        };
        let context = ToolContext {
            working_dir: &root,
            editable_roots: &editable_roots,
            trusted_read_roots: &[],
            client: None,
            approval: &approval,
            folder_access: &folder_access,
            cancellation: &cancellation,
            loaded_tools: &loaded_tools,
            loaded_skills: &loaded_skills,
            skill_registry: &skill_registry,
            bundled_script_runtime: None,
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
        let loaded_skills = LoadedSkills::default();
        let skill_registry = test_skill_registry(&root);
        let desktop = TestDesktop::default();
        let cancellation = CancellationToken::new();
        let editable_roots = EditableRoots::for_test(&root);
        let folder_access = TestFolderAccess {
            allowed: false,
            calls: AtomicUsize::new(0),
        };
        let context = ToolContext {
            working_dir: &root,
            editable_roots: &editable_roots,
            trusted_read_roots: &[],
            client: None,
            approval: &approval,
            folder_access: &folder_access,
            cancellation: &cancellation,
            loaded_tools: &loaded_tools,
            loaded_skills: &loaded_skills,
            skill_registry: &skill_registry,
            bundled_script_runtime: None,
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
        let loaded_skills = LoadedSkills::default();
        let skill_registry = test_skill_registry(&root);
        let desktop = TestDesktop::default();
        let cancellation = CancellationToken::new();
        let editable_roots = EditableRoots::for_test(&root);
        let folder_access = TestFolderAccess {
            allowed: false,
            calls: AtomicUsize::new(0),
        };
        let context = ToolContext {
            working_dir: &root,
            editable_roots: &editable_roots,
            trusted_read_roots: &[],
            client: None,
            approval: &approval,
            folder_access: &folder_access,
            cancellation: &cancellation,
            loaded_tools: &loaded_tools,
            loaded_skills: &loaded_skills,
            skill_registry: &skill_registry,
            bundled_script_runtime: None,
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

    #[tokio::test]
    async fn exact_remembered_action_skips_approval_but_changed_args_ask_again() {
        let root = test_dir();
        let approval = RememberingApproval::default();
        let loaded_tools = tool_view::LoadedTools::default();
        let loaded_skills = LoadedSkills::default();
        let skill_registry = test_skill_registry(&root);
        let desktop = TestDesktop::default();
        let cancellation = CancellationToken::new();
        let editable_roots = EditableRoots::for_test(&root);
        let folder_access = TestFolderAccess {
            allowed: false,
            calls: AtomicUsize::new(0),
        };
        let context = ToolContext {
            working_dir: &root,
            editable_roots: &editable_roots,
            trusted_read_roots: &[],
            client: None,
            approval: &approval,
            folder_access: &folder_access,
            cancellation: &cancellation,
            loaded_tools: &loaded_tools,
            loaded_skills: &loaded_skills,
            skill_registry: &skill_registry,
            bundled_script_runtime: None,
            desktop: &desktop,
        };
        let original = ToolCallPayload {
            tool: "os.fs.trash".into(),
            args: serde_json::json!({"paths": ["result.txt"]}),
        };
        std::fs::write(root.join("result.txt"), "one").unwrap();

        assert!(authorize_call(&original, &context).await.is_ok());
        let fingerprint = approval.requests.lock().unwrap()[0].fingerprint.clone();
        approval.allowed.lock().unwrap().insert(fingerprint);
        assert!(authorize_call(&original, &context).await.is_ok());
        assert_eq!(approval.requests.lock().unwrap().len(), 1);

        let changed = ToolCallPayload {
            tool: "os.fs.trash".into(),
            args: serde_json::json!({"paths": ["other.txt"]}),
        };
        std::fs::write(root.join("other.txt"), "two").unwrap();
        assert!(authorize_call(&changed, &context).await.is_ok());
        assert_eq!(approval.requests.lock().unwrap().len(), 2);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn folder_access_then_destructive_action_can_be_remembered() {
        let parent = test_dir();
        let root = parent.join("root");
        tokio::fs::create_dir(&root).await.unwrap();
        let approval = RememberingApproval::default();
        let loaded_tools = tool_view::LoadedTools::default();
        let loaded_skills = LoadedSkills::default();
        let skill_registry = test_skill_registry(&root);
        let desktop = TestDesktop::default();
        let cancellation = CancellationToken::new();
        let editable_roots = EditableRoots::for_test(&root);
        let folder_access = TestFolderAccess {
            allowed: true,
            calls: AtomicUsize::new(0),
        };
        let context = ToolContext {
            working_dir: &root,
            editable_roots: &editable_roots,
            trusted_read_roots: &[],
            client: None,
            approval: &approval,
            folder_access: &folder_access,
            cancellation: &cancellation,
            loaded_tools: &loaded_tools,
            loaded_skills: &loaded_skills,
            skill_registry: &skill_registry,
            bundled_script_runtime: None,
            desktop: &desktop,
        };
        let escaped = ToolCallPayload {
            tool: "os.fs.trash".into(),
            args: serde_json::json!({"paths": ["../outside.txt"]}),
        };
        std::fs::write(parent.join("outside.txt"), "one").unwrap();

        assert!(authorize_call(&escaped, &context).await.is_ok());
        let request = approval.requests.lock().unwrap()[0].clone();
        assert!(request.can_remember);
        approval.allowed.lock().unwrap().insert(request.fingerprint);

        assert!(authorize_call(&escaped, &context).await.is_ok());
        assert_eq!(approval.requests.lock().unwrap().len(), 1);
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[tokio::test]
    async fn remembered_fingerprint_cannot_bypass_shell_hard_block() {
        let root = test_dir();
        let blocked_args = serde_json::json!({"cmd": "echo ready && sudo rm -rf /"});
        let approval = RememberingApproval::default();
        approval
            .allowed
            .lock()
            .unwrap()
            .insert(fingerprint_prepared_action("os.shell.run", &blocked_args));
        let loaded_tools = tool_view::LoadedTools::default();
        let loaded_skills = LoadedSkills::default();
        let skill_registry = test_skill_registry(&root);
        let desktop = TestDesktop::default();
        let cancellation = CancellationToken::new();
        let editable_roots = EditableRoots::for_test(&root);
        let folder_access = TestFolderAccess {
            allowed: false,
            calls: AtomicUsize::new(0),
        };
        let context = ToolContext {
            working_dir: &root,
            editable_roots: &editable_roots,
            trusted_read_roots: &[],
            client: None,
            approval: &approval,
            folder_access: &folder_access,
            cancellation: &cancellation,
            loaded_tools: &loaded_tools,
            loaded_skills: &loaded_skills,
            skill_registry: &skill_registry,
            bundled_script_runtime: None,
            desktop: &desktop,
        };

        let denied = authorize_call(
            &ToolCallPayload {
                tool: "os.shell.run".into(),
                args: blocked_args,
            },
            &context,
        )
        .await
        .unwrap_err();

        assert_eq!(denied.status, ToolStatus::Denied);
        assert!(approval.requests.lock().unwrap().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn skill_scripts_always_require_approval() {
        let root = test_dir();
        let approval = TestApproval {
            approved: false,
            calls: AtomicUsize::new(0),
        };
        let loaded_tools = tool_view::LoadedTools::default();
        let loaded_skills = LoadedSkills::default();
        let skill_registry = test_script_skill_registry(&root);
        let desktop = TestDesktop::default();
        let cancellation = CancellationToken::new();
        let editable_roots = EditableRoots::for_test(&root);
        let folder_access = TestFolderAccess {
            allowed: false,
            calls: AtomicUsize::new(0),
        };
        let context = ToolContext {
            working_dir: &root,
            editable_roots: &editable_roots,
            trusted_read_roots: &[],
            client: None,
            approval: &approval,
            folder_access: &folder_access,
            cancellation: &cancellation,
            loaded_tools: &loaded_tools,
            loaded_skills: &loaded_skills,
            skill_registry: &skill_registry,
            bundled_script_runtime: None,
            desktop: &desktop,
        };

        let denied = execute(
            &ToolCallPayload {
                tool: "skill.run_script".into(),
                args: serde_json::json!({
                    "skill": "test-skill",
                    "script": "inspect.sh"
                }),
            },
            &context,
        )
        .await;
        assert_eq!(denied.status, ToolStatus::Denied);
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

    #[test]
    fn approval_preview_includes_bounded_scrubbed_skill_arguments() {
        let preview = safe_preview(&ToolCallPayload {
            tool: "skill.run_script".into(),
            args: serde_json::json!({
                "skill": "github",
                "script": "inspect.ts",
                "args": [
                    "--repo",
                    "AtomicBot-ai/Atomic-Chat",
                    "Authorization: Bearer secret",
                    "https://user:password@example.com/path?token=secret"
                ],
                "timeout_ms": 30_000
            }),
        });

        assert_eq!(preview["args"][0], "--repo");
        assert_eq!(preview["args"][1], "AtomicBot-ai/Atomic-Chat");
        assert_eq!(preview["args"][2], "<redacted>");
        assert_eq!(preview["args"][3], "https://example.com/path");
        assert_eq!(preview["argument_count"], 4);
        assert!(!preview.to_string().contains("secret"));
        assert!(!preview.to_string().contains("password"));
    }

    #[test]
    fn approval_preview_marks_arguments_beyond_the_visible_limit() {
        let arguments = (0..20)
            .map(|index| format!("argument-{index}"))
            .collect::<Vec<_>>();
        let preview = safe_preview(&ToolCallPayload {
            tool: "skill.run_script".into(),
            args: serde_json::json!({
                "skill": "test-skill",
                "script": "inspect.sh",
                "args": arguments
            }),
        });

        assert_eq!(preview["argument_count"], 20);
        assert_eq!(preview["args"].as_array().unwrap().len(), 17);
        assert_eq!(preview["args"][16], "<4 additional arguments omitted>");
    }

    #[test]
    fn approval_preview_summarizes_destructive_filesystem_calls_without_content() {
        let write = safe_preview(&ToolCallPayload {
            tool: "os.fs.write".into(),
            args: serde_json::json!({
                "path": "/workspace/file.txt",
                "content": "sensitive body",
                "mode": "replace"
            }),
        });
        assert_eq!(write["mode"], "replace");
        assert_eq!(write["byte_count"], 14);
        assert!(write.get("content").is_none());

        let trash = safe_preview(&ToolCallPayload {
            tool: "os.fs.trash".into(),
            args: serde_json::json!({
                "paths": ["/workspace/a.png", "/workspace/b.png"]
            }),
        });
        assert_eq!(trash["count"], 2);
        assert_eq!(trash["paths"].as_array().unwrap().len(), 2);

        let extract = safe_preview(&ToolCallPayload {
            tool: "os.fs.archive.extract".into(),
            args: serde_json::json!({
                "path": "/workspace/input.zip",
                "destination": "/workspace/out",
                "overwrite": true
            }),
        });
        assert_eq!(extract["overwrite"], true);
        assert_eq!(
            extract["limits"]["maxEntries"],
            archive::MAX_EXTRACT_ENTRIES
        );

        let patch = safe_preview(&ToolCallPayload {
            tool: "os.fs.patch".into(),
            args: serde_json::json!({
                "patch": "sensitive patch body",
                "apply": true,
                "patch_paths": ["/workspace/file.txt"]
            }),
        });
        assert_eq!(patch["apply"], true);
        assert_eq!(patch["targets"][0], "/workspace/file.txt");
        assert!(patch.get("patch").is_none());
    }
}
