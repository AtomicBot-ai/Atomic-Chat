use tokio::process::Command;

use super::{command_outcome, ToolContext};
use crate::core::agent::types::ToolOutcome;

pub async fn read(_context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let output = if cfg!(target_os = "macos") {
        Command::new("pbpaste").output().await
    } else if cfg!(windows) {
        Command::new("powershell")
            .args(["-NoProfile", "-Command", "Get-Clipboard -Raw"])
            .output()
            .await
    } else {
        match Command::new("wl-paste")
            .args(["--no-newline"])
            .output()
            .await
        {
            Ok(output) if output.status.success() => Ok(output),
            _ => {
                Command::new("xclip")
                    .args(["-selection", "clipboard", "-o"])
                    .output()
                    .await
            }
        }
    }
    .map_err(|error| ToolOutcome::error(format!("Could not read clipboard: {error}")))?;
    command_outcome(output)
}
