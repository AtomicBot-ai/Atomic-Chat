use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Terminal status of a single tool execution.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolStatus {
    Ok,
    Error,
    /// Blocked by the loop guard (`deniedReason: "tool-loop"`) or approval.
    Denied,
    /// The turn was cancelled mid-flight.
    Cancelled,
}

/// Compressed outcome of one tool call. Ported from
/// `CompressedToolResult` (result-compressor.ts) — a short human summary
/// plus optional structured details, never the raw payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolOutcome {
    pub status: ToolStatus,
    /// One-line human-readable summary of what happened.
    pub summary: String,
    /// Optional structured details (error kind, denied reason, ...).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl ToolOutcome {
    pub fn ok(summary: impl Into<String>) -> Self {
        Self {
            status: ToolStatus::Ok,
            summary: summary.into(),
            details: None,
        }
    }

    pub fn error(summary: impl Into<String>) -> Self {
        Self {
            status: ToolStatus::Error,
            summary: summary.into(),
            details: None,
        }
    }

    pub fn denied(summary: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            status: ToolStatus::Denied,
            summary: summary.into(),
            details: Some(serde_json::json!({ "deniedReason": reason.into() })),
        }
    }
}

pub(crate) fn required_string(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Missing non-empty string argument `{key}`"))
}

pub(crate) fn optional_usize(args: &Value, key: &str, default: usize, max: usize) -> usize {
    args.get(key)
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
        .min(max)
}

pub(crate) fn truncate(mut value: String, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value;
    }
    value = value.chars().take(max_chars).collect();
    value.push_str("\n[truncated]");
    value
}
