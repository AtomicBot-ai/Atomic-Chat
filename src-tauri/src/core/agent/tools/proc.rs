use serde_json::Value;
use sysinfo::System;
use tokio::process::Command;

use super::{command_outcome, optional_usize, ToolContext};
use crate::core::agent::types::ToolOutcome;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ProcessSignal {
    Term,
    Kill,
    Int,
    Hup,
}

impl ProcessSignal {
    fn unix_name(self) -> &'static str {
        match self {
            Self::Term => "TERM",
            Self::Kill => "KILL",
            Self::Int => "INT",
            Self::Hup => "HUP",
        }
    }
}

pub async fn execute(
    tool: &str,
    args: &Value,
    _context: &ToolContext<'_>,
) -> Result<ToolOutcome, ToolOutcome> {
    match tool {
        "os.proc.list" => list(args).await,
        "os.proc.kill" => kill(args).await,
        _ => Err(ToolOutcome::error(format!("Unsupported proc tool: {tool}"))),
    }
}

async fn list(args: &Value) -> Result<ToolOutcome, ToolOutcome> {
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
    Ok(ToolOutcome::ok(rows.join("\n")))
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
    let signal = match args
        .get("signal")
        .and_then(Value::as_str)
        .unwrap_or("SIGTERM")
        .to_ascii_uppercase()
        .as_str()
    {
        "TERM" | "SIGTERM" => ProcessSignal::Term,
        "KILL" | "SIGKILL" => ProcessSignal::Kill,
        "INT" | "SIGINT" => ProcessSignal::Int,
        "HUP" | "SIGHUP" => ProcessSignal::Hup,
        value => {
            return Err(format!(
                "Unsupported process signal `{value}`; use SIGTERM, SIGKILL, SIGINT, or SIGHUP"
            ))
        }
    };
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
