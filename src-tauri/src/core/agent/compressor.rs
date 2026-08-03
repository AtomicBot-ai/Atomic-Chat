use super::types::ToolStatus;

const DEFAULT_MAX_SUMMARY_CHARS: usize = 400;
const DEFAULT_MAX_TAIL_LINES: usize = 12;
const TRUNCATED_MARKER: &str = "\n… [truncated]";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompressedToolResult {
    pub summary: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogSummary {
    pub total_lines: usize,
    pub error_lines: usize,
    pub warning_lines: usize,
    pub pass_count: usize,
    pub fail_count: usize,
    pub first_error: Option<String>,
    pub first_failure: Option<String>,
}

pub fn compress_tool_result(tool: &str, status: ToolStatus, output: &str) -> CompressedToolResult {
    compress_tool_result_with_limits(
        tool,
        status,
        output,
        DEFAULT_MAX_SUMMARY_CHARS,
        DEFAULT_MAX_TAIL_LINES,
    )
}

pub fn should_compress_tool(tool: &str) -> bool {
    matches!(
        tool,
        "os.shell.run"
            | "os.fs.read"
            | "os.fs.list"
            | "os.fs.glob"
            | "os.fs.grep"
            | "os.fs.read_document"
            | "os.fs.archive.list"
            | "os.fs.archive.read_entry"
            | "os.fs.diff"
            | "os.git.status"
            | "os.git.log"
            | "os.git.diff"
            | "os.git.show"
            | "os.git.blame"
            | "os.git.branch"
            | "os.proc.list"
            | "os.http.request"
            | "os.web.search"
            | "os.web.fetch"
            | "vision.describe"
    )
}

pub fn summarise_log(output: &str) -> LogSummary {
    let lines = output
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect::<Vec<_>>();
    let mut summary = LogSummary {
        total_lines: lines.len(),
        error_lines: 0,
        warning_lines: 0,
        pass_count: 0,
        fail_count: 0,
        first_error: None,
        first_failure: None,
    };

    for line in lines {
        let lower = line.to_ascii_lowercase();
        if contains_word(&lower, "error") || contains_word(&lower, "exception") {
            summary.error_lines += 1;
            if summary.first_error.is_none() {
                summary.first_error = Some(take_chars(line.trim(), 200));
            }
        } else if contains_word(&lower, "warn") || contains_word(&lower, "warning") {
            summary.warning_lines += 1;
        }

        if contains_case_sensitive_word(line, "PASSED")
            || contains_case_sensitive_word(line, "PASS")
            || contains_case_sensitive_word(line, "ok")
        {
            summary.pass_count += 1;
        }
        if contains_case_sensitive_word(line, "FAILED")
            || contains_case_sensitive_word(line, "FAIL")
        {
            summary.fail_count += 1;
            if summary.first_failure.is_none() {
                summary.first_failure = Some(take_chars(line.trim(), 200));
            }
        }
    }

    summary
}

fn compress_tool_result_with_limits(
    _tool: &str,
    status: ToolStatus,
    output: &str,
    max_summary_chars: usize,
    max_tail_lines: usize,
) -> CompressedToolResult {
    let normalized = output.replace("\r\n", "\n");
    let normalized = normalized.trim_end();
    let (tail, tail_truncated) = extract_tail(normalized, max_tail_lines);
    let signature = extract_signature(normalized, status);
    let joined = [
        signature.as_deref(),
        (!tail.is_empty()).then_some(tail.as_str()),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("\n");
    let over_length = joined.chars().count() > max_summary_chars;
    let summary = if over_length {
        let keep = max_summary_chars.saturating_sub(TRUNCATED_MARKER.chars().count());
        format!("{}{TRUNCATED_MARKER}", take_chars(&joined, keep))
    } else {
        joined
    };

    CompressedToolResult {
        summary,
        truncated: tail_truncated || over_length,
    }
}

fn extract_tail(text: &str, max_lines: usize) -> (String, bool) {
    if text.is_empty() {
        return (String::new(), false);
    }
    let lines = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>();
    if lines.len() <= max_lines {
        return (lines.join("\n"), false);
    }
    let omitted = lines.len() - max_lines;
    (
        format!(
            "… [omitted {omitted} lines]\n{}",
            lines[lines.len() - max_lines..].join("\n")
        ),
        true,
    )
}

fn extract_signature(text: &str, status: ToolStatus) -> Option<String> {
    if status != ToolStatus::Error {
        return None;
    }
    text.lines().find_map(|line| {
        let lower = line.to_ascii_lowercase();
        [
            "error:",
            "failed:",
            "traceback (most recent call last)",
            "assertionerror",
            "exception:",
        ]
        .iter()
        .any(|marker| lower.contains(marker))
        .then(|| format!("key: {}", take_chars(line.trim(), 180)))
    })
}

fn contains_word(value: &str, needle: &str) -> bool {
    value
        .match_indices(needle)
        .any(|(index, _)| word_boundary(value, index, needle.len()))
}

fn contains_case_sensitive_word(value: &str, needle: &str) -> bool {
    value
        .match_indices(needle)
        .any(|(index, _)| word_boundary(value, index, needle.len()))
}

fn word_boundary(value: &str, index: usize, len: usize) -> bool {
    let before = value[..index].chars().next_back();
    let after = value[index + len..].chars().next();
    before.map_or(true, |ch| !ch.is_alphanumeric() && ch != '_')
        && after.map_or(true, |ch| !ch.is_alphanumeric() && ch != '_')
}

fn take_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_short_output_and_normalizes_crlf() {
        let result = compress_tool_result("os.fs.read", ToolStatus::Ok, "hello\r\nworld\r\n");

        assert_eq!(result.summary, "hello\nworld");
        assert!(!result.truncated);
    }

    #[test]
    fn trims_to_the_configured_tail_and_marks_omitted_lines() {
        let output = (0..20)
            .map(|index| format!("line {index}"))
            .collect::<Vec<_>>()
            .join("\n");
        let result =
            compress_tool_result_with_limits("os.shell.run", ToolStatus::Ok, &output, 200, 4);

        assert!(result.summary.contains("… [omitted 16 lines]"));
        assert!(result.summary.contains("line 19"));
        assert!(!result.summary.contains("line 0\n"));
        assert!(result.truncated);
    }

    #[test]
    fn extracts_the_first_error_signature() {
        let output = [
            "running tests ...",
            "test_auth.py::test_refresh FAILED",
            "E   AssertionError: session None after refresh",
            "====== 1 failed, 2 passed ======",
        ]
        .join("\n");
        let result = compress_tool_result("os.shell.run", ToolStatus::Error, &output);

        assert!(result.summary.contains("key: E   AssertionError"));
        assert!(result.summary.contains("1 failed, 2 passed"));
    }

    #[test]
    fn enforces_a_unicode_safe_character_budget() {
        let output = "Ж".repeat(600);
        let result =
            compress_tool_result_with_limits("os.fs.read", ToolStatus::Ok, &output, 80, 12);

        assert!(result.summary.chars().count() <= 80);
        assert!(result.summary.ends_with("… [truncated]"));
        assert!(result.truncated);
    }

    #[test]
    fn empty_output_stays_empty() {
        let result = compress_tool_result("os.fs.read", ToolStatus::Ok, "");

        assert_eq!(result.summary, "");
        assert!(!result.truncated);
    }

    #[test]
    fn summarises_common_log_signals() {
        let summary = summarise_log(
            "PASS suite/a.test.ts\nFAIL suite/b.test.ts\nError: boom\nwarn: flaky\nPASS suite/c.test.ts",
        );

        assert_eq!(summary.total_lines, 5);
        assert_eq!(summary.error_lines, 1);
        assert_eq!(summary.warning_lines, 1);
        assert_eq!(summary.pass_count, 2);
        assert_eq!(summary.fail_count, 1);
        assert_eq!(summary.first_error.as_deref(), Some("Error: boom"));
        assert_eq!(
            summary.first_failure.as_deref(),
            Some("FAIL suite/b.test.ts")
        );
    }

    #[test]
    fn log_line_count_matches_split_semantics() {
        assert_eq!(summarise_log("").total_lines, 1);
        assert_eq!(summarise_log("ok\r\n").total_lines, 2);
    }
}
