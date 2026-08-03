use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub const API_REQUEST_SUMMARY_CHANNEL: &str = "analytics://api_server_session_summary";
pub const API_REQUEST_SUMMARY_WINDOW_SECS: u64 = 180;

#[derive(Debug)]
pub struct ApiRequestObservation {
    pub endpoint: &'static str,
    pub method: String,
    pub model_id: Option<String>,
    pub backend: &'static str,
    pub provider: Option<String>,
    pub stream: bool,
    pub status: u16,
    pub latency_ms: u64,
    pub is_anthropic_fallback: bool,
    pub error_kind: Option<&'static str>,
    pub upstream_status: Option<u16>,
    pub oom_detected: bool,
    pub ctx_overflow_detected: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ApiRequestSummary {
    pub source: &'static str,
    pub window_started_at_ms: u64,
    pub window_ended_at_ms: u64,
    pub window_duration_ms: u64,
    pub request_count: u64,
    pub success_count: u64,
    pub client_error_count: u64,
    pub server_error_count: u64,
    pub other_status_count: u64,
    pub latency_sum_ms: u64,
    pub latency_avg_ms: u64,
    pub latency_max_ms: u64,
    pub stream_request_count: u64,
    pub anthropic_fallback_count: u64,
    pub oom_count: u64,
    pub ctx_overflow_count: u64,
    pub endpoint_counts: BTreeMap<String, u64>,
    pub method_counts: BTreeMap<String, u64>,
    pub backend_counts: BTreeMap<String, u64>,
    pub provider_counts: BTreeMap<String, u64>,
    pub status_counts: BTreeMap<String, u64>,
    pub upstream_status_counts: BTreeMap<String, u64>,
    pub error_kind_counts: BTreeMap<String, u64>,
    pub models_used: Vec<String>,
}

#[derive(Debug)]
struct AggregateWindow {
    started_at_ms: u64,
    request_count: u64,
    success_count: u64,
    client_error_count: u64,
    server_error_count: u64,
    other_status_count: u64,
    latency_sum_ms: u64,
    latency_max_ms: u64,
    stream_request_count: u64,
    anthropic_fallback_count: u64,
    oom_count: u64,
    ctx_overflow_count: u64,
    endpoint_counts: BTreeMap<String, u64>,
    method_counts: BTreeMap<String, u64>,
    backend_counts: BTreeMap<String, u64>,
    provider_counts: BTreeMap<String, u64>,
    status_counts: BTreeMap<String, u64>,
    upstream_status_counts: BTreeMap<String, u64>,
    error_kind_counts: BTreeMap<String, u64>,
    models_used: BTreeSet<String>,
}

impl AggregateWindow {
    fn new(started_at_ms: u64) -> Self {
        Self {
            started_at_ms,
            request_count: 0,
            success_count: 0,
            client_error_count: 0,
            server_error_count: 0,
            other_status_count: 0,
            latency_sum_ms: 0,
            latency_max_ms: 0,
            stream_request_count: 0,
            anthropic_fallback_count: 0,
            oom_count: 0,
            ctx_overflow_count: 0,
            endpoint_counts: BTreeMap::new(),
            method_counts: BTreeMap::new(),
            backend_counts: BTreeMap::new(),
            provider_counts: BTreeMap::new(),
            status_counts: BTreeMap::new(),
            upstream_status_counts: BTreeMap::new(),
            error_kind_counts: BTreeMap::new(),
            models_used: BTreeSet::new(),
        }
    }

    fn record(&mut self, observation: ApiRequestObservation) {
        self.request_count += 1;
        match observation.status {
            200..=299 => self.success_count += 1,
            400..=499 => self.client_error_count += 1,
            500..=599 => self.server_error_count += 1,
            _ => self.other_status_count += 1,
        }

        self.latency_sum_ms = self.latency_sum_ms.saturating_add(observation.latency_ms);
        self.latency_max_ms = self.latency_max_ms.max(observation.latency_ms);
        self.stream_request_count += u64::from(observation.stream);
        self.anthropic_fallback_count += u64::from(observation.is_anthropic_fallback);
        self.oom_count += u64::from(observation.oom_detected);
        self.ctx_overflow_count += u64::from(observation.ctx_overflow_detected);

        increment(&mut self.endpoint_counts, observation.endpoint.to_string());
        increment(&mut self.method_counts, observation.method);
        increment(&mut self.backend_counts, observation.backend.to_string());
        increment(&mut self.status_counts, observation.status.to_string());

        if let Some(provider) = observation.provider {
            increment(&mut self.provider_counts, provider);
        }
        if let Some(upstream_status) = observation.upstream_status {
            increment(
                &mut self.upstream_status_counts,
                upstream_status.to_string(),
            );
        }
        if let Some(error_kind) = observation.error_kind {
            increment(&mut self.error_kind_counts, error_kind.to_string());
        }
        if let Some(model_id) = observation.model_id {
            self.models_used.insert(model_id);
        }
    }

    fn into_summary(self, ended_at_ms: u64) -> Option<ApiRequestSummary> {
        if self.request_count == 0 {
            return None;
        }

        Some(ApiRequestSummary {
            source: "local_api_server",
            window_started_at_ms: self.started_at_ms,
            window_ended_at_ms: ended_at_ms,
            window_duration_ms: ended_at_ms.saturating_sub(self.started_at_ms),
            request_count: self.request_count,
            success_count: self.success_count,
            client_error_count: self.client_error_count,
            server_error_count: self.server_error_count,
            other_status_count: self.other_status_count,
            latency_sum_ms: self.latency_sum_ms,
            latency_avg_ms: self.latency_sum_ms / self.request_count,
            latency_max_ms: self.latency_max_ms,
            stream_request_count: self.stream_request_count,
            anthropic_fallback_count: self.anthropic_fallback_count,
            oom_count: self.oom_count,
            ctx_overflow_count: self.ctx_overflow_count,
            endpoint_counts: self.endpoint_counts,
            method_counts: self.method_counts,
            backend_counts: self.backend_counts,
            provider_counts: self.provider_counts,
            status_counts: self.status_counts,
            upstream_status_counts: self.upstream_status_counts,
            error_kind_counts: self.error_kind_counts,
            models_used: self.models_used.into_iter().collect(),
        })
    }
}

#[derive(Debug)]
pub struct ApiRequestAggregator {
    window: Mutex<AggregateWindow>,
}

impl Default for ApiRequestAggregator {
    fn default() -> Self {
        Self::new()
    }
}

impl ApiRequestAggregator {
    pub fn new() -> Self {
        Self::new_at(now_ms())
    }

    fn new_at(started_at_ms: u64) -> Self {
        Self {
            window: Mutex::new(AggregateWindow::new(started_at_ms)),
        }
    }

    pub fn record(&self, observation: ApiRequestObservation) {
        self.window
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .record(observation);
    }

    pub fn drain(&self) -> Option<ApiRequestSummary> {
        self.drain_at(now_ms())
    }

    fn drain_at(&self, ended_at_ms: u64) -> Option<ApiRequestSummary> {
        let mut window = self
            .window
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let completed = std::mem::replace(&mut *window, AggregateWindow::new(ended_at_ms));
        completed.into_summary(ended_at_ms)
    }
}

fn increment<K>(counts: &mut BTreeMap<K, u64>, key: K)
where
    K: Ord,
{
    *counts.entry(key).or_default() += 1;
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observation(status: u16, latency_ms: u64) -> ApiRequestObservation {
        ApiRequestObservation {
            endpoint: "chat/completions",
            method: "POST".to_string(),
            model_id: Some("atomic/model".to_string()),
            backend: "llamacpp-upstream",
            provider: None,
            stream: true,
            status,
            latency_ms,
            is_anthropic_fallback: false,
            error_kind: None,
            upstream_status: None,
            oom_detected: false,
            ctx_overflow_detected: false,
        }
    }

    #[test]
    fn empty_window_does_not_emit() {
        let aggregator = ApiRequestAggregator::new_at(1_000);

        assert_eq!(aggregator.drain_at(181_000), None);
    }

    #[test]
    fn aggregates_counts_latency_dimensions_and_flags() {
        let aggregator = ApiRequestAggregator::new_at(1_000);
        aggregator.record(observation(200, 100));

        let mut failed = observation(503, 500);
        failed.endpoint = "responses";
        failed.model_id = Some("atomic/other".to_string());
        failed.backend = "remote";
        failed.provider = Some("openrouter".to_string());
        failed.stream = false;
        failed.is_anthropic_fallback = true;
        failed.error_kind = Some("remote_provider_error");
        failed.upstream_status = Some(429);
        failed.oom_detected = true;
        failed.ctx_overflow_detected = true;
        aggregator.record(failed);

        let mut rejected = observation(401, 300);
        rejected.model_id = Some("atomic/model".to_string());
        rejected.error_kind = Some("auth");
        aggregator.record(rejected);

        let summary = aggregator.drain_at(181_000).expect("summary");
        assert_eq!(summary.request_count, 3);
        assert_eq!(summary.success_count, 1);
        assert_eq!(summary.client_error_count, 1);
        assert_eq!(summary.server_error_count, 1);
        assert_eq!(summary.other_status_count, 0);
        assert_eq!(summary.latency_sum_ms, 900);
        assert_eq!(summary.latency_avg_ms, 300);
        assert_eq!(summary.latency_max_ms, 500);
        assert_eq!(summary.stream_request_count, 2);
        assert_eq!(summary.anthropic_fallback_count, 1);
        assert_eq!(summary.oom_count, 1);
        assert_eq!(summary.ctx_overflow_count, 1);
        assert_eq!(summary.endpoint_counts["chat/completions"], 2);
        assert_eq!(summary.endpoint_counts["responses"], 1);
        assert_eq!(summary.backend_counts["llamacpp-upstream"], 2);
        assert_eq!(summary.backend_counts["remote"], 1);
        assert_eq!(summary.provider_counts["openrouter"], 1);
        assert_eq!(summary.status_counts["200"], 1);
        assert_eq!(summary.status_counts["401"], 1);
        assert_eq!(summary.status_counts["503"], 1);
        assert_eq!(summary.upstream_status_counts["429"], 1);
        assert_eq!(summary.error_kind_counts["auth"], 1);
        assert_eq!(summary.error_kind_counts["remote_provider_error"], 1);
        assert_eq!(
            summary.models_used,
            vec!["atomic/model".to_string(), "atomic/other".to_string()]
        );
        assert_eq!(summary.window_duration_ms, 180_000);
    }

    #[test]
    fn drain_resets_the_window() {
        let aggregator = ApiRequestAggregator::new_at(1_000);
        aggregator.record(observation(200, 100));

        assert!(aggregator.drain_at(181_000).is_some());
        assert_eq!(aggregator.drain_at(361_000), None);

        aggregator.record(observation(201, 50));
        let summary = aggregator.drain_at(541_000).expect("summary");
        assert_eq!(summary.window_started_at_ms, 361_000);
        assert_eq!(summary.request_count, 1);
        assert_eq!(summary.success_count, 1);
    }
}
