use serde_json::Value;
use tokio::process::Command;

use super::{command_outcome, required_string, resolve_path, ToolContext};
use crate::core::agent::shell_guard::{join_command_stream, needs_shell_interpretation};
use crate::core::agent::types::ToolOutcome;
use crate::core::process_env::sanitize_tokio_command;

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

/// Resolve an invocation to the concrete program and arguments to execute.
///
/// Commands that need shell interpretation (pipes, `&&`, globs, redirection)
/// are wrapped in the platform subshell; everything else is exec'd directly.
/// `os.proc.spawn` shares this so a command behaves identically whether it is
/// run to completion or left running.
pub(super) fn resolve_program(invocation: &ShellInvocation) -> (String, Vec<String>) {
    if !needs_shell_interpretation(&invocation.program, &invocation.arguments) {
        return (invocation.program.clone(), invocation.arguments.clone());
    }
    let command_line = join_command_stream(&invocation.program, &invocation.arguments);
    #[cfg(windows)]
    {
        ("cmd.exe".to_owned(), vec!["/C".to_owned(), command_line])
    }
    #[cfg(not(windows))]
    {
        ("sh".to_owned(), vec!["-c".to_owned(), command_line])
    }
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
    let (program, arguments) = resolve_program(&invocation);
    let mut command = Command::new(&program);
    command.args(&arguments);
    sanitize_tokio_command(&mut command);
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
    fn direct_execs_a_plain_command_and_subshells_an_interpreted_one() {
        let plain =
            parse_invocation(&serde_json::json!({"cmd": "git", "args": ["status"]})).unwrap();
        assert_eq!(
            resolve_program(&plain),
            ("git".to_owned(), vec!["status".to_owned()])
        );

        let piped = parse_invocation(&serde_json::json!({"cmd": "ls | wc -l"})).unwrap();
        let (program, arguments) = resolve_program(&piped);
        assert_ne!(program, "ls | wc -l");
        assert_eq!(arguments.len(), 2);
        assert!(arguments[1].contains('|'));
    }

    #[test]
    fn rejects_malformed_args() {
        assert!(parse_invocation(&serde_json::json!({"cmd": "echo", "args": "hello"})).is_err());
        assert!(parse_invocation(&serde_json::json!({"cmd": "echo", "args": [42]})).is_err());
    }
}
