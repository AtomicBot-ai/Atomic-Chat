use serde_json::Value;

use super::{required_string, ToolContext};
use crate::core::agent::types::ToolOutcome;

const MAX_NOTIFICATION_TITLE_CHARS: usize = 128;
const MAX_NOTIFICATION_BODY_CHARS: usize = 2_048;

pub async fn execute(args: &Value, context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let title = required_string(args, "title").map_err(ToolOutcome::error)?;
    let body = args
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    validate_length("Notification title", &title, MAX_NOTIFICATION_TITLE_CHARS)?;
    validate_length("Notification body", &body, MAX_NOTIFICATION_BODY_CHARS)?;
    context
        .desktop
        .notify(title, body)
        .await
        .map_err(|error| ToolOutcome::error(format!("Could not show notification: {error}")))?;
    Ok(ToolOutcome::ok("Notification delivered"))
}

fn validate_length(label: &str, value: &str, limit: usize) -> Result<(), ToolOutcome> {
    if value.chars().count() > limit {
        return Err(ToolOutcome::error(format!(
            "{label} exceeds the {limit}-character limit"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_oversized_title_and_body() {
        assert!(validate_length("title", &"x".repeat(129), 128).is_err());
        assert!(validate_length("body", &"x".repeat(2_049), 2_048).is_err());
    }
}
