use serde_json::Value;

use super::{required_string, ToolContext};
use crate::core::agent::types::ToolOutcome;

pub async fn execute(args: &Value, context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let name = required_string(args, "name").map_err(ToolOutcome::error)?;
    Ok(context
        .loaded_skills
        .view(&name, context.skill_registry)
        .await)
}
