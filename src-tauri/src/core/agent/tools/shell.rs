use serde_json::Value;
use tokio::process::Command;

use super::{command_outcome, required_string, resolve_path, ToolContext};
use crate::core::agent::types::ToolOutcome;

pub async fn execute(args: &Value, context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let program = required_string(args, "cmd").map_err(ToolOutcome::error)?;
    let arguments =
        args.get("args")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .map(|value| {
                        value.as_str().map(str::to_owned).ok_or_else(|| {
                            ToolOutcome::error("Every `args` value must be a string")
                        })
                    })
                    .collect::<Result<Vec<_>, _>>()
            })
            .transpose()?
            .unwrap_or_default();
    let cwd = args
        .get("cwd")
        .and_then(Value::as_str)
        .map(|value| resolve_path(context.working_dir, value))
        .unwrap_or_else(|| context.working_dir.to_path_buf());
    let timeout_ms = args
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(120_000)
        .clamp(1_000, 600_000);
    let mut command = Command::new(program);
    command.args(arguments).current_dir(cwd).kill_on_drop(true);
    let output = tokio::select! {
        _ = context.cancellation.cancelled() => {
            return Err(ToolOutcome {
                status: crate::core::agent::types::ToolStatus::Cancelled,
                summary: "Shell command cancelled".into(),
                details: None,
            });
        }
        result = tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), command.output()) => {
            result
                .map_err(|_| ToolOutcome::error(format!("Shell command timed out after {timeout_ms}ms")))?
                .map_err(|error| ToolOutcome::error(format!("Could not run command: {error}")))?
        }
    };
    command_outcome(output)
}
