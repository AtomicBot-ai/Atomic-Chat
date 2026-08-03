use serde_json::Value;
use tokio::process::Command;

use super::{command_outcome, required_string, resolve_path, ToolContext};
use crate::core::agent::shell_guard::{join_command_stream, needs_shell_interpretation};
use crate::core::agent::types::ToolOutcome;

pub(super) struct ShellInvocation {
    pub program: String,
    pub arguments: Vec<String>,
}

pub(super) fn parse_invocation(args: &Value) -> Result<ShellInvocation, ToolOutcome> {
    let program = required_string(args, "cmd").map_err(ToolOutcome::error)?;
    let arguments = match args.get("args") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| ToolOutcome::error("Every `args` value must be a string"))
            })
            .collect::<Result<Vec<_>, _>>()?,
        Some(_) => return Err(ToolOutcome::error("`args` must be an array of strings")),
    };
    Ok(ShellInvocation { program, arguments })
}

pub async fn execute(args: &Value, context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let invocation = parse_invocation(args)?;
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
    let shell_mode = needs_shell_interpretation(&invocation.program, &invocation.arguments);
    let mut command = if shell_mode {
        platform_shell_command(join_command_stream(
            &invocation.program,
            &invocation.arguments,
        ))
    } else {
        let mut command = Command::new(&invocation.program);
        command.args(&invocation.arguments);
        command
    };
    command.current_dir(cwd).kill_on_drop(true);
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

#[cfg(windows)]
fn platform_shell_command(command_line: String) -> Command {
    let mut command = Command::new("cmd.exe");
    command.arg("/C").arg(command_line);
    command
}

#[cfg(not(windows))]
fn platform_shell_command(command_line: String) -> Command {
    let mut command = Command::new("sh");
    command.arg("-c").arg(command_line);
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_structured_invocation() {
        let invocation =
            parse_invocation(&serde_json::json!({"cmd": "git", "args": ["status", "--short"]}))
                .unwrap();
        assert_eq!(invocation.program, "git");
        assert_eq!(invocation.arguments, ["status", "--short"]);
    }

    #[test]
    fn rejects_malformed_args() {
        assert!(parse_invocation(&serde_json::json!({"cmd": "echo", "args": "hello"})).is_err());
        assert!(parse_invocation(&serde_json::json!({"cmd": "echo", "args": [42]})).is_err());
    }
}
