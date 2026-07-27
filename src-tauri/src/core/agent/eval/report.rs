use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::scoring::normalize_answer;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GaiaToolTrace {
    pub tool: String,
    pub args: serde_json::Value,
    pub status: String,
    pub summary: String,
    pub details: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GaiaTaskStatus {
    Correct,
    Incorrect,
    Error,
    Timeout,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GaiaTaskResult {
    pub task_id: String,
    pub level: u8,
    pub question: String,
    pub prediction: Option<String>,
    pub normalized_prediction: Option<String>,
    pub gold_answer: String,
    pub correct: bool,
    pub status: GaiaTaskStatus,
    pub terminal_reason: Option<String>,
    pub step_count: u32,
    pub tool_trace: Vec<GaiaToolTrace>,
    pub duration_ms: u128,
    pub error: Option<String>,
}

impl GaiaTaskResult {
    pub fn prediction(
        task_id: String,
        level: u8,
        question: String,
        prediction: String,
        gold_answer: String,
        correct: bool,
    ) -> Self {
        Self {
            task_id,
            level,
            question,
            normalized_prediction: Some(normalize_answer(&prediction)),
            prediction: Some(prediction),
            gold_answer,
            correct,
            status: if correct {
                GaiaTaskStatus::Correct
            } else {
                GaiaTaskStatus::Incorrect
            },
            terminal_reason: None,
            step_count: 0,
            tool_trace: Vec::new(),
            duration_ms: 0,
            error: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GaiaLevelSummary {
    pub total: usize,
    pub correct: usize,
    pub accuracy: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GaiaSummary {
    pub total: usize,
    pub correct: usize,
    pub incorrect: usize,
    pub error: usize,
    pub timeout: usize,
    pub accuracy: f64,
    pub by_level: BTreeMap<u8, GaiaLevelSummary>,
    pub elapsed_ms: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GaiaReport {
    pub dataset: String,
    pub model: String,
    pub generated_at_unix_ms: u128,
    pub summary: GaiaSummary,
    pub tasks: Vec<GaiaTaskResult>,
}

pub fn aggregate_results(results: &[GaiaTaskResult], elapsed_ms: u128) -> GaiaSummary {
    let mut summary = GaiaSummary {
        total: results.len(),
        correct: 0,
        incorrect: 0,
        error: 0,
        timeout: 0,
        accuracy: 0.0,
        by_level: BTreeMap::new(),
        elapsed_ms,
    };
    for result in results {
        let level = summary.by_level.entry(result.level).or_default();
        level.total += 1;
        match result.status {
            GaiaTaskStatus::Correct => {
                summary.correct += 1;
                level.correct += 1;
            }
            GaiaTaskStatus::Incorrect => summary.incorrect += 1,
            GaiaTaskStatus::Error => summary.error += 1,
            GaiaTaskStatus::Timeout => summary.timeout += 1,
        }
    }
    summary.accuracy = accuracy(summary.correct, summary.total);
    for level in summary.by_level.values_mut() {
        level.accuracy = accuracy(level.correct, level.total);
    }
    summary
}

pub fn write_report(report: &GaiaReport, path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create report directory: {error}"))?;
    }
    let json = serde_json::to_vec_pretty(report)
        .map_err(|error| format!("Failed to serialize GAIA report: {error}"))?;
    std::fs::write(path, json)
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))
}

fn accuracy(correct: usize, total: usize) -> f64 {
    if total == 0 {
        0.0
    } else {
        correct as f64 / total as f64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aggregates_statuses_and_levels() {
        let correct =
            GaiaTaskResult::prediction("a".into(), 1, "Q".into(), "A".into(), "A".into(), true);
        let incorrect =
            GaiaTaskResult::prediction("b".into(), 2, "Q".into(), "B".into(), "A".into(), false);
        let mut error = incorrect.clone();
        error.task_id = "c".into();
        error.level = 3;
        error.status = GaiaTaskStatus::Error;
        let mut timeout = incorrect.clone();
        timeout.task_id = "d".into();
        timeout.status = GaiaTaskStatus::Timeout;
        let summary = aggregate_results(&[correct, incorrect, error, timeout], 10);
        assert_eq!(summary.total, 4);
        assert_eq!(summary.correct, 1);
        assert_eq!(summary.incorrect, 1);
        assert_eq!(summary.error, 1);
        assert_eq!(summary.timeout, 1);
        assert_eq!(summary.elapsed_ms, 10);
        assert_eq!(summary.by_level[&1].accuracy, 1.0);
        assert_eq!(summary.by_level[&2].accuracy, 0.0);
        assert_eq!(summary.by_level[&3].accuracy, 0.0);
    }
}
