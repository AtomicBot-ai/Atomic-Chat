use serde_json::{json, Value};
use sysinfo::System;
use tokio::process::Command;

use super::{
    command_outcome, optional_usize, required_string, resolve_path, truncate, ToolContext,
    MAX_TOOL_OUTPUT_CHARS,
};
use crate::core::agent::pty::{ProcStatus, ProcessSignal, ReadPage, SpawnRequest};
use crate::core::agent::types::{ToolOutcome, ToolStatus};

/// Default page size for `os.proc.read`. Well under the tool output ceiling so
/// a chatty build does not evict the rest of the step from the context window;
/// the model pages forward when it needs more.
const DEFAULT_READ_CHARS: usize = 4_000;

pub async fn execute(
    tool: &str,
    args: &Value,
    context: &ToolContext<'_>,
) -> Result<ToolOutcome, ToolOutcome> {
    match tool {
        "os.proc.list" => list(args, context).await,
        "os.proc.kill" => kill(args).await,
        "os.proc.spawn" => spawn(args, context).await,
        "os.proc.read" => read(args, context).await,
        "os.proc.write" => write(args, context).await,
        "os.proc.stop" => stop(args, context).await,
        _ => Err(ToolOutcome::error(format!("Unsupported proc tool: {tool}"))),
    }
}

async fn spawn(args: &Value, context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let invocation = super::shell::parse_invocation(args)?;
    let (program, arguments) = super::shell::resolve_program(&invocation);
    let cwd = args
        .get("cwd")
        .and_then(Value::as_str)
        .map(|value| resolve_path(context.working_dir, value))
        .unwrap_or_else(|| context.working_dir.to_path_buf());
    let status = context
        .pty
        .spawn(SpawnRequest {
            session_id: context.session_id.to_owned(),
            program,
            args: arguments,
            cwd,
            cols: optional_u16(args, "cols"),
            rows: optional_u16(args, "rows"),
        })
        .map_err(ToolOutcome::error)?;
    Ok(ToolOutcome {
        status: ToolStatus::Ok,
        summary: format!(
            "Started {} as {}. Read its output with os.proc.read.",
            status.label, status.proc_id
        ),
        details: Some(json!({ "procId": status.proc_id, "pid": status.pid })),
    })
}

async fn read(args: &Value, context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let proc_id = required_string(args, "procId").map_err(ToolOutcome::error)?;
    let since = args.get("since").and_then(Value::as_u64);
    let max_chars = optional_usize(args, "maxChars", DEFAULT_READ_CHARS, MAX_TOOL_OUTPUT_CHARS);
    let page = context
        .pty
        .read(context.session_id, &proc_id, since, max_chars)
        .map_err(ToolOutcome::error)?;
    Ok(read_outcome(page))
}

fn read_outcome(page: ReadPage) -> ToolOutcome {
    let ReadPage { status, slice } = page;
    let mut header = describe_brief(&status);
    if slice.dropped_lines > 0 {
        header.push_str(&format!(
            " · {} earlier lines dropped (output ring is full)",
            slice.dropped_lines
        ));
    }
    if slice.truncated {
        header.push_str(" · more output waiting, call os.proc.read again");
    }
    let summary = if slice.text.is_empty() {
        format!("{header} · no new output")
    } else {
        format!(
            "{header}
{}",
            slice.text
        )
    };
    ToolOutcome {
        status: ToolStatus::Ok,
        summary: truncate(summary, MAX_TOOL_OUTPUT_CHARS),
        details: Some(json!({
            "procId": status.proc_id,
            "running": status.running,
            "exit": status.exit,
            "nextCursor": slice.next_cursor,
            "truncated": slice.truncated,
            "droppedLines": slice.dropped_lines,
        })),
    }
}

async fn write(args: &Value, context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let proc_id = required_string(args, "procId").map_err(ToolOutcome::error)?;
    let data = args
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolOutcome::error("Missing string argument `data`"))?;
    let status = context
        .pty
        .write(context.session_id, &proc_id, data)
        .map_err(ToolOutcome::error)?;
    Ok(ToolOutcome::ok(format!(
        "Wrote {} bytes to {}. Read the response with os.proc.read.",
        data.len(),
        status.proc_id
    )))
}

async fn stop(args: &Value, context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let proc_id = required_string(args, "procId").map_err(ToolOutcome::error)?;
    let signal = match args.get("signal").and_then(Value::as_str) {
        Some(value) => ProcessSignal::parse(value).map_err(ToolOutcome::error)?,
        None => ProcessSignal::Term,
    };
    let status = context
        .pty
        .stop(context.session_id, &proc_id, signal)
        .map_err(ToolOutcome::error)?;
    Ok(ToolOutcome::ok(format!(
        "Sent SIG{} to {}. Its remaining output is still readable with os.proc.read.",
        signal.unix_name(),
        status.proc_id
    )))
}

/// Status line for `os.proc.list`, where the command is what identifies a
/// process to the reader.
fn describe(status: &ProcStatus) -> String {
    format!("{} ({})", describe_brief(status), status.label)
}

/// Status line for `os.proc.read`. Deliberately omits the command: the model
/// already knows what it started, and this header is prepended to every page of
/// a process it may poll dozens of times.
fn describe_brief(status: &ProcStatus) -> String {
    match &status.exit {
        None => format!("{} running for {}s", status.proc_id, status.uptime_secs),
        Some(exit) => match &exit.signal {
            Some(signal) => format!("{} killed by SIG{signal}", status.proc_id),
            None => format!("{} exited with code {}", status.proc_id, exit.code),
        },
    }
}

fn optional_u16(args: &Value, key: &str) -> Option<u16> {
    args.get(key)
        .and_then(Value::as_u64)
        .and_then(|value| u16::try_from(value).ok())
        .filter(|value| *value > 0)
}

async fn list(args: &Value, context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let owned = context
        .pty
        .list(context.session_id)
        .iter()
        .map(describe)
        .collect::<Vec<_>>();
    let filter = args
        .get("filter")
        .and_then(Value::as_str)
        .map(str::to_lowercase);
    let max_entries = optional_usize(args, "maxEntries", 100, 500);
    let rows = tokio::task::spawn_blocking(move || {
        let mut system = System::new_all();
        system.refresh_all();
        let mut rows = system
            .processes()
            .iter()
            .filter_map(|(pid, process)| {
                let name = process.name().to_string_lossy();
                if filter
                    .as_ref()
                    .is_some_and(|needle| !name.to_lowercase().contains(needle))
                {
                    return None;
                }
                Some((
                    pid.as_u32(),
                    format!("{}\t{}\t{}", pid, process.memory(), name),
                ))
            })
            .collect::<Vec<_>>();
        rows.sort_unstable_by_key(|(pid, _)| *pid);
        rows.into_iter()
            .take(max_entries)
            .map(|(_, row)| row)
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|error| ToolOutcome::error(error.to_string()))?;
    let mut sections = Vec::new();
    if owned.is_empty() {
        sections.push("Agent-started processes: none".to_owned());
    } else {
        sections.push(format!(
            "Agent-started processes ({}):\n{}",
            owned.len(),
            owned.join("\n")
        ));
    }
    sections.push(format!(
        "System processes (pid\tmemory\tname):\n{}",
        rows.join("\n")
    ));
    Ok(ToolOutcome::ok(truncate(
        sections.join("\n\n"),
        MAX_TOOL_OUTPUT_CHARS,
    )))
}

async fn kill(args: &Value) -> Result<ToolOutcome, ToolOutcome> {
    let (pid, signal) = validate_kill_args(args).map_err(ToolOutcome::error)?;
    let output = if cfg!(windows) {
        let mut command = Command::new("taskkill");
        command.args(["/PID", &pid.to_string()]);
        if signal == ProcessSignal::Kill {
            command.arg("/F");
        }
        command.output().await
    } else {
        Command::new("kill")
            .args([format!("-{}", signal.unix_name()), pid.to_string()])
            .output()
            .await
    }
    .map_err(|error| ToolOutcome::error(error.to_string()))?;
    command_outcome(output)
}

pub(super) fn validate_kill_args(args: &Value) -> Result<(u32, ProcessSignal), String> {
    let pid = args
        .get("pid")
        .and_then(Value::as_u64)
        .filter(|pid| *pid > 0 && *pid <= i32::MAX as u64)
        .ok_or_else(|| format!("`pid` must be an integer between 1 and {}", i32::MAX))?;
    let signal = ProcessSignal::parse(
        args.get("signal")
            .and_then(Value::as_str)
            .unwrap_or("SIGTERM"),
    )?;
    Ok((pid as u32, signal))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_positive_pid_and_normalizes_signals() {
        assert_eq!(
            validate_kill_args(&serde_json::json!({"pid": 42})).unwrap(),
            (42, ProcessSignal::Term)
        );
        assert_eq!(
            validate_kill_args(&serde_json::json!({"pid": 42, "signal": "kill"})).unwrap(),
            (42, ProcessSignal::Kill)
        );
        assert_eq!(
            validate_kill_args(&serde_json::json!({"pid": 42, "signal": "SIGINT"})).unwrap(),
            (42, ProcessSignal::Int)
        );
    }

    #[test]
    fn rejects_dangerous_pids_and_unknown_signals() {
        for args in [
            serde_json::json!({"pid": 0}),
            serde_json::json!({"pid": -1}),
            serde_json::json!({"pid": 1.5}),
            serde_json::json!({"pid": i32::MAX as u64 + 1}),
        ] {
            assert!(validate_kill_args(&args).is_err(), "{args}");
        }
        assert!(validate_kill_args(&serde_json::json!({
            "pid": 42,
            "signal": "STOP"
        }))
        .is_err());
    }
}
