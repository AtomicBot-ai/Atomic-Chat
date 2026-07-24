//! No-progress / repeat / wandering loop guard (`ToolLoopTracker` port).

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::types::{LoopDetector, ToolCallPayload, ToolOutcome, ToolStatus};

pub const BATCH_LOOP_LABEL: &str = "<batch>";
pub const LOOP_VETO_DENIED_REASON: &str = "tool-loop";
pub const LOOP_WARNING_BUCKET_SIZE: usize = 10;

const VOLATILE_RESULT_KEYS: &[&str] = &[
    "timestamp",
    "ts",
    "date",
    "time",
    "timeTotal",
    "timeTotalSeconds",
    "durationMs",
    "sizeDownload",
    "requestId",
    "request_id",
    "id",
    "traceId",
    "trace_id",
    "sentAt",
    "createdAt",
    "deliveredAt",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoopCheckLevel {
    Ok,
    Warn,
    Critical,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoopCheckVerdict {
    pub level: LoopCheckLevel,
    pub count: usize,
    pub detector: LoopDetector,
    pub warning_key: String,
    pub tool: String,
    pub args_hash: String,
}

#[derive(Debug, Clone)]
pub struct ToolLoopTrackerOptions {
    pub warning_threshold: usize,
    pub critical_threshold: usize,
    pub breaker_veto_streak: usize,
    pub history_size: usize,
    pub warning_bucket_size: usize,
    pub wandering_threshold: usize,
    pub wandering_escalation: usize,
}

impl Default for ToolLoopTrackerOptions {
    fn default() -> Self {
        Self {
            warning_threshold: 3,
            critical_threshold: 5,
            breaker_veto_streak: 3,
            history_size: 40,
            warning_bucket_size: LOOP_WARNING_BUCKET_SIZE,
            wandering_threshold: 6,
            wandering_escalation: 12,
        }
    }
}

#[derive(Debug, Clone)]
struct HistoryEntry {
    tool: String,
    args_hash: String,
    result_hash: Option<String>,
    vetoed: bool,
}

pub struct ToolLoopTracker {
    warning_threshold: usize,
    critical_threshold: usize,
    breaker_veto_streak: usize,
    history_size: usize,
    warning_bucket_size: usize,
    wandering_threshold: usize,
    wandering_escalation: usize,
    history: Vec<HistoryEntry>,
    warning_buckets: HashMap<String, usize>,
    consecutive_veto_signature: Option<String>,
    consecutive_veto_count: usize,
}

impl Default for ToolLoopTracker {
    fn default() -> Self {
        Self::new(ToolLoopTrackerOptions::default())
    }
}

impl ToolLoopTracker {
    pub fn new(options: ToolLoopTrackerOptions) -> Self {
        let warning_threshold = options.warning_threshold.max(2);
        let critical_threshold = options.critical_threshold.max(warning_threshold);
        let wandering_threshold = options.wandering_threshold.max(2);
        let wandering_escalation = options.wandering_escalation.max(wandering_threshold);
        Self {
            warning_threshold,
            critical_threshold,
            breaker_veto_streak: options.breaker_veto_streak.max(1),
            history_size: options
                .history_size
                .max(critical_threshold)
                .max(wandering_escalation),
            warning_bucket_size: options.warning_bucket_size.max(1),
            wandering_threshold,
            wandering_escalation,
            history: Vec::new(),
            warning_buckets: HashMap::new(),
            consecutive_veto_signature: None,
            consecutive_veto_count: 0,
        }
    }

    pub fn check(&self, tool: &str, args: &Value) -> LoopCheckVerdict {
        let args_hash = hash_tool_call(tool, args);
        let (no_progress, latest_result_hash) = no_progress_streak(&self.history, tool, &args_hash);
        if no_progress >= self.critical_threshold {
            return verdict(
                LoopCheckLevel::Critical,
                no_progress,
                LoopDetector::NoProgress,
                format!(
                    "critical:{tool}:{args_hash}:{}",
                    latest_result_hash.as_deref().unwrap_or("none")
                ),
                tool,
                args_hash,
            );
        }
        if is_wandering_prone_tool(tool) {
            let spread = self.effective_spread(tool, &args_hash);
            if spread >= self.wandering_threshold {
                return verdict(
                    LoopCheckLevel::Warn,
                    spread,
                    LoopDetector::Wandering,
                    format!("wandering:{tool}"),
                    tool,
                    args_hash,
                );
            }
        }
        let repeats = repeat_count(&self.history, tool, &args_hash);
        if repeats >= self.warning_threshold {
            return verdict(
                LoopCheckLevel::Warn,
                repeats,
                LoopDetector::GenericRepeat,
                format!("warn:{tool}:{args_hash}"),
                tool,
                args_hash,
            );
        }
        verdict(
            LoopCheckLevel::Ok,
            0,
            LoopDetector::GenericRepeat,
            format!("ok:{tool}:{args_hash}"),
            tool,
            args_hash,
        )
    }

    pub fn record_call(&mut self, tool: &str, args: &Value) {
        self.history.push(HistoryEntry {
            tool: tool.to_owned(),
            args_hash: hash_tool_call(tool, args),
            result_hash: None,
            vetoed: false,
        });
        self.trim_history();
    }

    pub fn record_outcome(&mut self, tool: &str, args: &Value, outcome: &ToolOutcome) {
        if is_loop_veto_result(outcome) {
            self.patch_latest_pending(tool, args, None, true);
            self.note_veto(tool, args);
            return;
        }
        let Some(result_hash) = hash_tool_outcome(tool, outcome) else {
            return;
        };
        self.patch_latest_pending(tool, args, Some(result_hash), false);
        if let Some(signature) = self.consecutive_veto_signature.as_deref() {
            if signature != hash_tool_call(tool, args) {
                self.consecutive_veto_signature = None;
                self.consecutive_veto_count = 0;
            }
        }
    }

    pub fn note_veto(&mut self, tool: &str, args: &Value) {
        let signature = hash_tool_call(tool, args);
        if self.consecutive_veto_signature.as_deref() == Some(&signature) {
            self.consecutive_veto_count += 1;
        } else {
            self.consecutive_veto_signature = Some(signature);
            self.consecutive_veto_count = 1;
        }
    }

    pub fn is_breaker_tripped(&self, tool: &str, args: &Value) -> bool {
        self.consecutive_veto_signature.as_deref() == Some(&hash_tool_call(tool, args))
            && self.consecutive_veto_count >= self.breaker_veto_streak
    }

    pub fn is_wandering_escalated(&self, tool: &str, args: &Value) -> bool {
        is_wandering_prone_tool(tool)
            && self.effective_spread(tool, &hash_tool_call(tool, args)) >= self.wandering_escalation
    }

    pub fn should_emit_warning(&mut self, warning_key: &str, count: usize) -> bool {
        if count < self.warning_threshold {
            return false;
        }
        let bucket = (count - self.warning_threshold) / self.warning_bucket_size;
        let previous = self.warning_buckets.get(warning_key).copied();
        if previous.is_some_and(|previous| bucket <= previous) {
            return false;
        }
        self.warning_buckets.insert(warning_key.to_owned(), bucket);
        true
    }

    pub fn observe_batch_composite(
        &mut self,
        calls: &[ToolCallPayload],
        results: &[ToolOutcome],
    ) -> LoopCheckVerdict {
        let args_hash = hash_canonical(&Value::Array(
            calls
                .iter()
                .map(|call| serde_json::json!([call.tool, call.args]))
                .collect(),
        ));
        let (no_progress, latest_result_hash) =
            no_progress_streak(&self.history, BATCH_LOOP_LABEL, &args_hash);
        let repeats = repeat_count(&self.history, BATCH_LOOP_LABEL, &args_hash);
        let result_hash = hash_canonical(&Value::Array(
            calls
                .iter()
                .enumerate()
                .map(|(index, call)| {
                    let outcome = results.get(index);
                    serde_json::json!({
                        "tool": call.tool,
                        "summary": outcome.map(|value| value.summary.as_str()).unwrap_or(""),
                        "status": outcome.map(|value| format!("{:?}", value.status)).unwrap_or_else(|| "Error".into()),
                    })
                })
                .collect(),
        ));
        let result = if no_progress >= self.critical_threshold {
            verdict(
                LoopCheckLevel::Critical,
                no_progress,
                LoopDetector::NoProgress,
                format!(
                    "critical:{BATCH_LOOP_LABEL}:{args_hash}:{}",
                    latest_result_hash.as_deref().unwrap_or("none")
                ),
                BATCH_LOOP_LABEL,
                args_hash.clone(),
            )
        } else if repeats >= self.warning_threshold {
            verdict(
                LoopCheckLevel::Warn,
                repeats,
                LoopDetector::GenericRepeat,
                format!("warn:{BATCH_LOOP_LABEL}:{args_hash}"),
                BATCH_LOOP_LABEL,
                args_hash.clone(),
            )
        } else {
            verdict(
                LoopCheckLevel::Ok,
                0,
                LoopDetector::GenericRepeat,
                format!("ok:{BATCH_LOOP_LABEL}:{args_hash}"),
                BATCH_LOOP_LABEL,
                args_hash.clone(),
            )
        };
        self.history.push(HistoryEntry {
            tool: BATCH_LOOP_LABEL.into(),
            args_hash,
            result_hash: Some(result_hash),
            vetoed: false,
        });
        self.trim_history();
        result
    }

    pub fn breaker_threshold(&self) -> usize {
        self.breaker_veto_streak
    }

    fn effective_spread(&self, tool: &str, current_args_hash: &str) -> usize {
        let seen: HashSet<&str> = self
            .history
            .iter()
            .filter(|entry| {
                entry.tool == tool
                    && entry
                        .result_hash
                        .as_ref()
                        .is_some_and(|hash| !hash.is_empty())
            })
            .map(|entry| entry.args_hash.as_str())
            .collect();
        seen.len() + usize::from(!seen.contains(current_args_hash))
    }

    fn patch_latest_pending(
        &mut self,
        tool: &str,
        args: &Value,
        result_hash: Option<String>,
        vetoed: bool,
    ) {
        let args_hash = hash_tool_call(tool, args);
        if let Some(entry) = self.history.iter_mut().rev().find(|entry| {
            entry.tool == tool
                && entry.args_hash == args_hash
                && entry.result_hash.is_none()
                && !entry.vetoed
        }) {
            entry.result_hash = result_hash;
            entry.vetoed = vetoed;
            return;
        }
        self.history.push(HistoryEntry {
            tool: tool.to_owned(),
            args_hash,
            result_hash,
            vetoed,
        });
        self.trim_history();
    }

    fn trim_history(&mut self) {
        if self.history.len() > self.history_size {
            self.history.drain(..self.history.len() - self.history_size);
        }
    }
}

pub fn is_wandering_prone_tool(tool: &str) -> bool {
    matches!(
        tool,
        "skill.view" | "os.web.fetch" | "os.web.search" | "os.http.request"
    ) || tool.starts_with("browser.")
}

pub fn is_loop_veto_result(outcome: &ToolOutcome) -> bool {
    matches!(outcome.status, ToolStatus::Error | ToolStatus::Denied)
        && outcome
            .details
            .as_ref()
            .and_then(|details| details.get("deniedReason"))
            .and_then(Value::as_str)
            == Some(LOOP_VETO_DENIED_REASON)
}

pub fn hash_tool_call(tool: &str, args: &Value) -> String {
    format!("{tool}:{}", hash_canonical(args))
}

pub fn hash_tool_outcome(tool: &str, outcome: &ToolOutcome) -> Option<String> {
    if is_loop_veto_result(outcome) {
        return None;
    }
    let details = outcome.details.as_ref().unwrap_or(&Value::Null);
    if outcome.status == ToolStatus::Error {
        let error_name = details
            .get("errorName")
            .and_then(Value::as_str)
            .unwrap_or("error");
        return Some(format!(
            "error:{}",
            hash_string(&format!("{error_name}:{}", outcome.summary))
        ));
    }
    if tool == "os.shell.run" {
        let exit_code = details
            .get("exitCode")
            .and_then(Value::as_i64)
            .map_or_else(|| "null".into(), |value| value.to_string());
        return Some(hash_string(&format!(
            "shell:{exit_code}:{}",
            outcome.summary
        )));
    }
    Some(hash_string(&format!(
        "{}:{}",
        outcome.summary,
        hash_canonical(&strip_volatile(details))
    )))
}

pub fn format_repeat_notice(verdict: &LoopCheckVerdict) -> String {
    format_loop_guidance(&verdict.tool, verdict.count, false)
}

pub fn format_veto_instruction(verdict: &LoopCheckVerdict) -> String {
    format_loop_guidance(&verdict.tool, verdict.count, true)
}

pub fn format_wandering_redirect(tool: &str, spread: usize) -> String {
    if tool == "skill.view" {
        return format!(
            "You have called `skill.view` with {spread} different skill names this turn without \
             converging. This is a wandering loop. STOP guessing skill names. Use only an enabled \
             skill listed under `### skills`, continue with the tools already available, or end \
             the turn with `reply` and your best-effort answer."
        );
    }
    format!(
        "You have called `{tool}` with {spread} different arguments this turn without converging. \
This is a wandering loop. STOP probing more URLs/pages and change strategy. \
Run `os.web.search` for a direct source, or end the turn with `reply` and your best-effort answer."
    )
}

pub fn format_forced_loop_reply(tool: &str, count: usize) -> String {
    format!(
        "(stopped: stuck in a no-progress loop on `{tool}` after {count} blocked attempts). \
I could not make further progress with the repeated tool call. \
Here is my best answer with the information gathered so far — the task may be incomplete."
    )
}

fn verdict(
    level: LoopCheckLevel,
    count: usize,
    detector: LoopDetector,
    warning_key: String,
    tool: &str,
    args_hash: String,
) -> LoopCheckVerdict {
    LoopCheckVerdict {
        level,
        count,
        detector,
        warning_key,
        tool: tool.to_owned(),
        args_hash,
    }
}

fn repeat_count(history: &[HistoryEntry], tool: &str, args_hash: &str) -> usize {
    history
        .iter()
        .filter(|entry| entry.tool == tool && entry.args_hash == args_hash)
        .count()
}

fn no_progress_streak(
    history: &[HistoryEntry],
    tool: &str,
    args_hash: &str,
) -> (usize, Option<String>) {
    let mut count = 0;
    let mut latest = None;
    for entry in history.iter().rev() {
        if entry.tool != tool || entry.args_hash != args_hash {
            continue;
        }
        let Some(result_hash) = entry.result_hash.as_ref().filter(|hash| !hash.is_empty()) else {
            continue;
        };
        if latest.is_none() {
            latest = Some(result_hash.clone());
            count = 1;
        } else if latest.as_deref() == Some(result_hash) {
            count += 1;
        } else {
            break;
        }
    }
    (count, latest)
}

fn strip_volatile(value: &Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.iter().map(strip_volatile).collect()),
        Value::Object(values) => Value::Object(
            values
                .iter()
                .filter(|(key, _)| !VOLATILE_RESULT_KEYS.contains(&key.as_str()))
                .map(|(key, value)| (key.clone(), strip_volatile(value)))
                .collect(),
        ),
        value => value.clone(),
    }
}

fn hash_canonical(value: &Value) -> String {
    hash_string(&canonical_json(value))
}

fn hash_string(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    format!("{digest:x}")[..12].to_owned()
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(values) => {
            let sorted: Map<String, Value> = values
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect();
            format!(
                "{{{}}}",
                sorted
                    .iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("JSON key serializes"),
                        canonical_json(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        value => serde_json::to_string(value).expect("JSON value serializes"),
    }
}

fn format_loop_guidance(tool: &str, count: usize, veto: bool) -> String {
    let header = if veto {
        format!("BLOCKED: `{tool}` was vetoed as a no-progress loop ({count} identical outcomes).")
    } else {
        format!("You called `{tool}` with the same arguments {count} times without progress.")
    };
    format!(
        "{header}\nChange strategy before calling another tool. \
Change the command, path, URL, or arguments; otherwise end the turn with `reply`."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outcome(summary: &str) -> ToolOutcome {
        ToolOutcome {
            status: ToolStatus::Ok,
            summary: summary.into(),
            details: Some(serde_json::json!({"value": 1})),
        }
    }

    fn record(tracker: &mut ToolLoopTracker, tool: &str, args: &Value, result: &ToolOutcome) {
        tracker.record_call(tool, args);
        tracker.record_outcome(tool, args, result);
    }

    #[test]
    fn warns_on_repeated_call_and_critically_vetoes_no_progress() {
        let mut tracker = ToolLoopTracker::default();
        let args = serde_json::json!({"path": "a"});
        for _ in 0..3 {
            record(&mut tracker, "os.fs.read", &args, &outcome("same"));
        }
        assert_eq!(
            tracker.check("os.fs.read", &args).level,
            LoopCheckLevel::Warn
        );
        for _ in 0..2 {
            record(&mut tracker, "os.fs.read", &args, &outcome("same"));
        }
        let verdict = tracker.check("os.fs.read", &args);
        assert_eq!(verdict.level, LoopCheckLevel::Critical);
        assert_eq!(verdict.detector, LoopDetector::NoProgress);
    }

    #[test]
    fn changed_result_breaks_no_progress_streak() {
        let mut tracker = ToolLoopTracker::default();
        let args = serde_json::json!({"path": "a"});
        for _ in 0..5 {
            record(&mut tracker, "os.fs.read", &args, &outcome("same"));
        }
        record(&mut tracker, "os.fs.read", &args, &outcome("changed"));
        assert_ne!(
            tracker.check("os.fs.read", &args).level,
            LoopCheckLevel::Critical
        );
    }

    #[test]
    fn vetoes_plateau_and_trip_breaker_separately() {
        let mut tracker = ToolLoopTracker::default();
        let args = serde_json::json!({"url": "https://example.com"});
        for _ in 0..3 {
            tracker.record_call("os.web.fetch", &args);
            tracker.record_outcome(
                "os.web.fetch",
                &args,
                &ToolOutcome::denied("loop", LOOP_VETO_DENIED_REASON),
            );
        }
        assert!(tracker.is_breaker_tripped("os.web.fetch", &args));
    }

    #[test]
    fn detects_and_escalates_wandering_distinct_arguments() {
        let mut options = ToolLoopTrackerOptions::default();
        options.wandering_threshold = 3;
        options.wandering_escalation = 4;
        let mut tracker = ToolLoopTracker::new(options);
        for index in 0..2 {
            let args = serde_json::json!({"url": format!("https://e/{index}")});
            record(&mut tracker, "os.web.fetch", &args, &outcome("page"));
        }
        let third = serde_json::json!({"url": "https://e/2"});
        assert_eq!(
            tracker.check("os.web.fetch", &third).detector,
            LoopDetector::Wandering
        );
        record(&mut tracker, "os.web.fetch", &third, &outcome("page"));
        assert!(tracker
            .is_wandering_escalated("os.web.fetch", &serde_json::json!({"url": "https://e/3"})));
        assert!(!tracker.is_wandering_escalated("os.fs.read", &serde_json::json!({"path": "new"})));
    }

    #[test]
    fn detects_varying_skill_view_names_as_wandering() {
        let mut options = ToolLoopTrackerOptions::default();
        options.wandering_threshold = 3;
        options.wandering_escalation = 4;
        let mut tracker = ToolLoopTracker::new(options);
        for name in ["pdf", "web-research"] {
            let args = serde_json::json!({"name": name});
            record(&mut tracker, "skill.view", &args, &outcome("not found"));
        }
        let third = serde_json::json!({"name": "documents"});
        let verdict = tracker.check("skill.view", &third);
        assert_eq!(verdict.detector, LoopDetector::Wandering);
        assert!(format_wandering_redirect("skill.view", verdict.count)
            .contains("STOP guessing skill names"));
        record(&mut tracker, "skill.view", &third, &outcome("not found"));
        assert!(tracker
            .is_wandering_escalated("skill.view", &serde_json::json!({"name": "another-skill"})));
    }

    #[test]
    fn volatile_result_fields_do_not_change_semantic_hash() {
        let left = ToolOutcome {
            status: ToolStatus::Ok,
            summary: "same".into(),
            details: Some(serde_json::json!({
                "nested": {"requestId": "a", "value": 3},
                "durationMs": 1
            })),
        };
        let right = ToolOutcome {
            status: ToolStatus::Ok,
            summary: "same".into(),
            details: Some(serde_json::json!({
                "nested": {"requestId": "b", "value": 3},
                "durationMs": 999
            })),
        };
        assert_eq!(
            hash_tool_outcome("os.http.request", &left),
            hash_tool_outcome("os.http.request", &right)
        );
    }

    #[test]
    fn canonical_call_hash_ignores_object_key_order() {
        assert_eq!(
            hash_tool_call("os.fs.read", &serde_json::json!({"b": 2, "a": 1})),
            hash_tool_call("os.fs.read", &serde_json::json!({"a": 1, "b": 2}))
        );
    }
}
