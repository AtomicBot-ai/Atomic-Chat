use serde_json::Value;
use tokio::process::Command;

use super::{command_outcome, optional_usize, required_string, resolve_path, ToolContext};
use crate::core::agent::types::ToolOutcome;

pub async fn execute(
    tool: &str,
    args: &Value,
    context: &ToolContext<'_>,
) -> Result<ToolOutcome, ToolOutcome> {
    let cwd = args
        .get("cwd")
        .and_then(Value::as_str)
        .map(|value| resolve_path(context.working_dir, value))
        .unwrap_or_else(|| context.working_dir.to_path_buf());
    let mut command = Command::new("git");
    command.current_dir(cwd);
    match tool {
        "os.git.status" => {
            command.args(["status", "--porcelain=v1", "--branch"]);
        }
        "os.git.log" => {
            command.args([
                "log",
                "--date=iso-strict",
                "--pretty=format:%H%x09%an%x09%ad%x09%s",
                &format!("--max-count={}", optional_usize(args, "maxCount", 20, 200)),
            ]);
            if let Some(path) = args.get("path").and_then(Value::as_str) {
                command.arg("--").arg(path);
            }
        }
        "os.git.diff" => {
            command.arg("diff");
            if args.get("staged").and_then(Value::as_bool) == Some(true) {
                command.arg("--staged");
            }
            if let Some(revision) = args.get("revision").and_then(Value::as_str) {
                command.arg(revision);
            }
            if let Some(path) = args.get("path").and_then(Value::as_str) {
                command.arg("--").arg(path);
            }
        }
        "os.git.show" => {
            command.args([
                "show",
                "--stat",
                "--format=fuller",
                &required_string(args, "revision").map_err(ToolOutcome::error)?,
            ]);
        }
        "os.git.blame" => {
            command
                .args(["blame", "--"])
                .arg(required_string(args, "path").map_err(ToolOutcome::error)?);
        }
        "os.git.branch" => {
            command.args(["branch", "--all", "--no-color"]);
        }
        _ => return Err(ToolOutcome::error(format!("Unsupported git tool: {tool}"))),
    }
    let output = command
        .output()
        .await
        .map_err(|error| ToolOutcome::error(format!("Could not run git: {error}")))?;
    command_outcome(output)
}
