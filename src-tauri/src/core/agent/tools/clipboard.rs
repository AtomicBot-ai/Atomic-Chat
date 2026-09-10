use serde_json::Value;
use tokio::process::Command;

use super::{command_outcome, required_string, ToolContext};
use crate::core::agent::types::ToolOutcome;

const MAX_CLIPBOARD_TEXT_CHARS: usize = 100_000;

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

pub async fn write(args: &Value, context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let text = required_string(args, "text").map_err(ToolOutcome::error)?;
    if text.chars().count() > MAX_CLIPBOARD_TEXT_CHARS {
        return Err(ToolOutcome::error(format!(
            "Clipboard text exceeds the {MAX_CLIPBOARD_TEXT_CHARS}-character limit"
        )));
    }
    context
        .desktop
        .write_clipboard(text)
        .await
        .map_err(|error| ToolOutcome::error(format!("Could not write clipboard: {error}")))?;
    Ok(ToolOutcome::ok("Clipboard updated"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipboard_limit_is_bounded() {
        assert_eq!(MAX_CLIPBOARD_TEXT_CHARS, 100_000);
    }
}
