use serde_json::Value;
use sysinfo::System;
use tokio::process::Command;

use super::{command_outcome, optional_usize, ToolContext};
use crate::core::agent::types::ToolOutcome;

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
        system
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
                Some(format!("{}\t{}\t{}", pid, process.memory(), name))
            })
            .take(max_entries)
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|error| ToolOutcome::error(error.to_string()))?;
    Ok(ToolOutcome::ok(rows.join("\n")))
}

async fn kill(args: &Value) -> Result<ToolOutcome, ToolOutcome> {
    let pid = args
        .get("pid")
        .and_then(Value::as_u64)
        .ok_or_else(|| ToolOutcome::error("Missing integer argument `pid`"))?;
    let output = if cfg!(windows) {
        Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T"])
            .output()
            .await
    } else {
        let signal = args.get("signal").and_then(Value::as_str).unwrap_or("TERM");
        Command::new("kill")
            .args([format!("-{signal}"), pid.to_string()])
            .output()
            .await
    }
    .map_err(|error| ToolOutcome::error(error.to_string()))?;
    command_outcome(output)
}
