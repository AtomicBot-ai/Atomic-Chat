//! Observation spill: keep oversized tool results retrievable instead of
//! destroying them.
//!
//! Verbose observations (fetched pages, parsed documents, shell output,
//! search results, vision descriptions) used to be compressed to a 400-char
//! tail before entering the model's conversation, which made their bodies
//! unrecoverable. The spill policy instead writes the full text into the task
//! workspace and hands the model a head+tail preview plus a locator naming
//! the exact tools that can page (`os.fs.read` with `offset`/`limit`) or
//! search (`os.fs.grep`) the saved file. The locator's byte cost is reserved
//! out of the preview budget so a replacement never exceeds the cap.
//!
//! `os.fs.read` itself is exempt from both spilling and compression: its
//! output is already bounded and model-paged, and exempting it prevents a
//! read -> spill -> read loop.

use std::path::Path;

use super::types::ToolOutcome;

/// Observations at or under this many chars stay inline untouched.
pub const SPILL_THRESHOLD_CHARS: usize = 4_000;
/// Chars of the observation head kept in the preview.
const SPILL_HEAD_CHARS: usize = 2_600;
/// Chars of the observation tail kept in the preview.
const SPILL_TAIL_CHARS: usize = 1_000;
/// Workspace-relative directory that holds spilled observations.
pub const SPILL_DIR: &str = ".agent/observations";

/// Tools whose oversized observations are spilled to disk. Listing tools
/// (`os.fs.list`, `os.git.*`, ...) keep the legacy tail compression instead —
/// their bodies are cheap to regenerate and rarely hold answers.
pub fn should_spill_tool(tool: &str) -> bool {
    matches!(
        tool,
        "os.shell.run"
            | "skill.run_script"
            | "os.fs.grep"
            | "os.fs.read_document"
            | "os.fs.archive.read_entry"
            | "os.http.request"
            | "os.web.search"
            | "os.web.fetch"
            | "docs.retrieve"
            | "docs.chunks"
            | "vision.describe"
    ) || tool.starts_with("os.media.")
}

/// Map a batch of outcomes to what the session should record: outcomes for
/// spill-eligible tools whose summaries exceed the threshold are replaced by
/// a preview plus a locator for the full text written into the workspace.
/// Best-effort: when the spill file cannot be written the original outcome is
/// kept (the session's own ceiling still truncates it).
pub fn spill_outcomes(
    working_dir: &Path,
    session_id: &str,
    turn_count: u64,
    step_index: u32,
    calls: &[super::types::ToolCallPayload],
    outcomes: &[ToolOutcome],
) -> Vec<ToolOutcome> {
    let session_slug = sanitize_component(session_id);
    calls
        .iter()
        .zip(outcomes)
        .enumerate()
        .map(|(batch_index, (call, outcome))| {
            if !should_spill_tool(&call.tool)
                || outcome.summary.chars().count() <= SPILL_THRESHOLD_CHARS
            {
                return outcome.clone();
            }
            // Session-scoped filename so concurrent threads (or a reused
            // default workspace, where turn_count restarts at 0) never
            // overwrite each other's spilled observations.
            let relative_path = format!(
                "{SPILL_DIR}/{session_slug}-turn{turn_count}-step{step_index}-{batch_index}-{}.txt",
                sanitize_tool_name(&call.tool)
            );
            match write_spill_file(working_dir, &relative_path, &outcome.summary) {
                Ok(()) => ToolOutcome {
                    status: outcome.status,
                    summary: preview_with_locator(&outcome.summary, &relative_path),
                    details: outcome.details.clone(),
                },
                Err(_) => outcome.clone(),
            }
        })
        .collect()
}

fn write_spill_file(working_dir: &Path, relative_path: &str, text: &str) -> std::io::Result<()> {
    let path = working_dir.join(relative_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, text)
}

/// Head + tail preview with an omission marker and a locator notice. Snaps
/// the head to the last newline and the tail to the first newline inside the
/// budget when one is reasonably close, so previews break on line boundaries.
fn preview_with_locator(text: &str, relative_path: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let total = chars.len();
    let head_end = snap_back(&chars, SPILL_HEAD_CHARS);
    let tail_start = snap_forward(&chars, total - SPILL_TAIL_CHARS);
    let omitted = tail_start.saturating_sub(head_end);
    let head: String = chars[..head_end].iter().collect();
    let tail: String = chars[tail_start..].iter().collect();
    format!(
        "{}\n… [omitted {omitted} of {total} chars] …\n{}\n{}",
        head.trim_end(),
        tail.trim_start(),
        locator_notice(relative_path)
    )
}

fn locator_notice(relative_path: &str) -> String {
    format!(
        "Full output saved to `{relative_path}`. Use os.fs.read {{path, offset, limit}} to page through it, or os.fs.grep {{pattern, path}} to search within it."
    )
}

/// Latest newline at or before `limit`, if one exists within the final
/// quarter of the budget; otherwise the hard limit.
fn snap_back(chars: &[char], limit: usize) -> usize {
    let limit = limit.min(chars.len());
    let floor = limit.saturating_sub(limit / 4);
    chars[..limit]
        .iter()
        .rposition(|&character| character == '\n')
        .filter(|&index| index >= floor)
        .unwrap_or(limit)
}

/// First newline at or after `start`, if one exists within the first quarter
/// of the tail budget; otherwise the hard start.
fn snap_forward(chars: &[char], start: usize) -> usize {
    let start = start.min(chars.len());
    let ceiling = (start + SPILL_TAIL_CHARS / 4).min(chars.len());
    chars[start..ceiling]
        .iter()
        .position(|&character| character == '\n')
        .map(|offset| start + offset + 1)
        .unwrap_or(start)
}

fn sanitize_tool_name(tool: &str) -> String {
    sanitize_component(tool)
}

fn sanitize_component(value: &str) -> String {
    let slug: String = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect();
    // Bound the length so a long session id cannot blow the path limit.
    slug.chars().take(48).collect()
}

#[cfg(test)]
mod tests {
    use super::super::types::{ToolCallPayload, ToolStatus};
    use super::*;

    fn call(tool: &str) -> ToolCallPayload {
        ToolCallPayload {
            tool: tool.into(),
            args: serde_json::json!({}),
        }
    }

    fn workspace() -> std::path::PathBuf {
        let dir = std::env::temp_dir()
            .join("atomic-spill-tests")
            .join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&dir).expect("create spill test workspace");
        dir
    }

    #[test]
    fn short_results_and_exempt_tools_pass_through_unchanged() {
        let dir = workspace();
        let long = "x".repeat(SPILL_THRESHOLD_CHARS + 100);
        let outcomes = spill_outcomes(
            &dir,
            "thread-a",
            0,
            0,
            &[call("os.web.fetch"), call("os.fs.read")],
            &[ToolOutcome::ok("short"), ToolOutcome::ok(long.clone())],
        );
        assert_eq!(outcomes[0].summary, "short");
        // os.fs.read is exempt even over the threshold.
        assert_eq!(outcomes[1].summary, long);
        assert!(!dir.join(SPILL_DIR).exists() || std::fs::read_dir(dir.join(SPILL_DIR)).map(|entries| entries.count()).unwrap_or(0) == 0);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn oversized_results_are_spilled_with_preview_and_locator() {
        let dir = workspace();
        let body = (0..600)
            .map(|index| format!("line {index} with some detail"))
            .collect::<Vec<_>>()
            .join("\n");
        let outcomes = spill_outcomes(
            &dir,
            "thread-a",
            2,
            5,
            &[call("os.web.fetch")],
            &[ToolOutcome::ok(body.clone())],
        );
        let summary = &outcomes[0].summary;
        assert!(summary.starts_with("line 0 with some detail"));
        assert!(summary.contains("… [omitted"));
        assert!(summary.contains("line 599 with some detail"));
        assert!(summary.contains("Full output saved to `"));
        assert!(summary.contains("os.fs.read"));
        assert!(summary.contains("os.fs.grep"));
        // Preview stays within the threshold plus the marker/locator reserve.
        assert!(summary.chars().count() <= SPILL_THRESHOLD_CHARS + 400);
        let spill_path = dir
            .join(SPILL_DIR)
            .join("thread-a-turn2-step5-0-os-web-fetch.txt");
        assert_eq!(
            std::fs::read_to_string(&spill_path).expect("read spill file"),
            body
        );
        assert_eq!(outcomes[0].status, ToolStatus::Ok);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn preview_budget_holds_for_unbroken_unicode_text() {
        let dir = workspace();
        let body = "щ".repeat(20_000);
        let outcomes = spill_outcomes(
            &dir,
            "thread-a",
            0,
            0,
            &[call("os.fs.read_document")],
            &[ToolOutcome::ok(body)],
        );
        let summary = &outcomes[0].summary;
        assert!(summary.contains("… [omitted"));
        assert!(summary.chars().count() <= SPILL_THRESHOLD_CHARS + 400);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn spill_failure_keeps_the_original_outcome() {
        // A file path in place of a directory makes create_dir_all fail.
        let dir = workspace();
        let blocker = dir.join(".agent");
        std::fs::write(&blocker, b"not a directory").expect("write blocker");
        let body = "y".repeat(SPILL_THRESHOLD_CHARS + 500);
        let outcomes = spill_outcomes(
            &dir,
            "thread-a",
            0,
            0,
            &[call("os.web.search")],
            &[ToolOutcome::ok(body.clone())],
        );
        assert_eq!(outcomes[0].summary, body);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn media_tools_are_spill_eligible() {
        assert!(should_spill_tool("os.media.transcribe"));
        assert!(should_spill_tool("os.media.youtube"));
        assert!(!should_spill_tool("os.fs.read"));
        assert!(!should_spill_tool("os.fs.list"));
    }
}
