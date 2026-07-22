use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Listener, Runtime};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::core::state::{AutoIncreaseOutcome, AutoIncreaseState};

const AUTO_INCREASE_EVENT: &str = "local_backend://auto_increase_ctx";
const AUTO_INCREASE_DONE_EVENT_PREFIX: &str = "local_backend://auto_increase_ctx_done";
const AUTO_INCREASE_TIMEOUT_SECS: u64 = 60;

#[derive(serde::Serialize, Clone)]
struct AutoIncreaseRequest<'a> {
    request_id: String,
    backend: &'a str,
    model_id: String,
    trigger: &'a str,
}

#[derive(serde::Deserialize, Clone, Debug)]
struct AutoIncreaseDoneEvent {
    ok: bool,
    #[serde(default)]
    new_ctx_len: Option<i64>,
    #[serde(default)]
    reason: Option<String>,
}

pub(crate) fn is_context_limit_error(status: u16, body: &str) -> bool {
    if !matches!(status, 400 | 413 | 500 | 503) {
        return false;
    }
    let body = body.to_lowercase();
    if body.contains("the request exceeds the available context size") {
        return true;
    }
    if body.contains("max_kv_size") || body.contains("max-kv-size") || body.contains("max kv size")
    {
        return true;
    }
    if body.contains("kv cache")
        && (body.contains("exceed") || body.contains("overflow") || body.contains("too"))
    {
        return true;
    }
    body.contains("context")
        && (body.contains("size")
            || body.contains("length")
            || body.contains("limit")
            || body.contains("exceed")
            || body.contains("overflow")
            || body.contains("too long")
            || body.contains("too large"))
}

pub(crate) async fn request_context_increase<R: Runtime>(
    app_handle: &AppHandle<R>,
    state: &AutoIncreaseState,
    backend: &str,
    model_id: &str,
    trigger: &str,
    cancellation: Option<&CancellationToken>,
) -> AutoIncreaseOutcome {
    let coordination_key = format!("{backend}:{model_id}");
    let (notify, is_leader) = acquire_slot(state, &coordination_key).await;
    if !is_leader {
        let wait = async {
            notify.notified().await;
            read_outcome(state, &coordination_key)
                .await
                .unwrap_or_else(|| failure("missing_leader_outcome"))
        };
        return await_with_timeout_and_cancellation(wait, cancellation).await;
    }

    let outcome =
        trigger_context_increase(app_handle, backend, model_id, trigger, cancellation).await;
    store_outcome(state, &coordination_key, outcome.clone()).await;
    release_slot(state, &coordination_key, &notify).await;
    outcome
}

async fn acquire_slot(state: &AutoIncreaseState, key: &str) -> (Arc<Notify>, bool) {
    let mut pending = state.pending.lock().await;
    if let Some(notify) = pending.get(key) {
        return (notify.clone(), false);
    }
    let notify = Arc::new(Notify::new());
    pending.insert(key.to_string(), notify.clone());
    drop(pending);
    state.last_outcome.lock().await.remove(key);
    (notify, true)
}

async fn release_slot(state: &AutoIncreaseState, key: &str, notify: &Notify) {
    state.pending.lock().await.remove(key);
    notify.notify_waiters();
}

async fn store_outcome(state: &AutoIncreaseState, key: &str, outcome: AutoIncreaseOutcome) {
    state
        .last_outcome
        .lock()
        .await
        .insert(key.to_string(), outcome);
}

async fn read_outcome(state: &AutoIncreaseState, key: &str) -> Option<AutoIncreaseOutcome> {
    state.last_outcome.lock().await.get(key).cloned()
}

async fn trigger_context_increase<R: Runtime>(
    app_handle: &AppHandle<R>,
    backend: &str,
    model_id: &str,
    trigger: &str,
    cancellation: Option<&CancellationToken>,
) -> AutoIncreaseOutcome {
    let request_id = Uuid::new_v4().to_string();
    let done_channel = format!("{AUTO_INCREASE_DONE_EVENT_PREFIX}/{request_id}");
    let (tx, rx) = tokio::sync::oneshot::channel::<AutoIncreaseDoneEvent>();
    let tx_slot = Arc::new(std::sync::Mutex::new(Some(tx)));
    let tx_clone = tx_slot.clone();
    let unlisten = app_handle.listen_any(done_channel, move |event| {
        match serde_json::from_str::<AutoIncreaseDoneEvent>(event.payload()) {
            Ok(done) => {
                if let Ok(mut sender) = tx_clone.lock() {
                    if let Some(sender) = sender.take() {
                        let _ = sender.send(done);
                    }
                }
            }
            Err(error) => log::warn!(
                "auto_increase_ctx_done payload parse failed: {error}; raw={}",
                event.payload()
            ),
        }
    });
    let request = AutoIncreaseRequest {
        request_id,
        backend,
        model_id: model_id.to_string(),
        trigger,
    };
    if let Err(error) = app_handle.emit(AUTO_INCREASE_EVENT, request) {
        app_handle.unlisten(unlisten);
        return failure(format!("emit_failed: {error}"));
    }
    let outcome = await_with_timeout_and_cancellation(
        async {
            match rx.await {
                Ok(done) => AutoIncreaseOutcome {
                    ok: done.ok,
                    new_ctx_len: done.new_ctx_len,
                    reason: done.reason,
                },
                Err(_) => failure("channel_closed"),
            }
        },
        cancellation,
    )
    .await;
    app_handle.unlisten(unlisten);
    outcome
}

async fn await_with_timeout_and_cancellation<F>(
    future: F,
    cancellation: Option<&CancellationToken>,
) -> AutoIncreaseOutcome
where
    F: std::future::Future<Output = AutoIncreaseOutcome>,
{
    await_with_deadline(
        future,
        cancellation,
        Duration::from_secs(AUTO_INCREASE_TIMEOUT_SECS),
        &format!("timeout_after_{AUTO_INCREASE_TIMEOUT_SECS}s"),
    )
    .await
}

async fn await_with_deadline<F>(
    future: F,
    cancellation: Option<&CancellationToken>,
    duration: Duration,
    timeout_reason: &str,
) -> AutoIncreaseOutcome
where
    F: std::future::Future<Output = AutoIncreaseOutcome>,
{
    let timeout = tokio::time::sleep(duration);
    tokio::pin!(future);
    tokio::pin!(timeout);
    if let Some(cancellation) = cancellation {
        tokio::select! {
            outcome = &mut future => outcome,
            _ = &mut timeout => failure(timeout_reason),
            _ = cancellation.cancelled() => failure("cancelled"),
        }
    } else {
        tokio::select! {
            outcome = &mut future => outcome,
            _ = &mut timeout => failure(timeout_reason),
        }
    }
}

fn failure(reason: impl Into<String>) -> AutoIncreaseOutcome {
    AutoIncreaseOutcome {
        ok: false,
        new_ctx_len: None,
        reason: Some(reason.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_only_context_failures_on_supported_statuses() {
        assert!(is_context_limit_error(
            400,
            r#"{"error":"the request exceeds the available context size"}"#
        ));
        assert!(is_context_limit_error(500, "MAX_KV_SIZE is too small"));
        assert!(!is_context_limit_error(429, "context limit exceeded"));
        assert!(!is_context_limit_error(500, "internal server error"));
    }

    #[tokio::test]
    async fn coordination_key_preserves_backend_identity() {
        let state = AutoIncreaseState::default();
        let (_first, first_is_leader) = acquire_slot(&state, "llamacpp:model").await;
        let (_same, same_is_leader) = acquire_slot(&state, "llamacpp:model").await;
        let (_other, other_is_leader) = acquire_slot(&state, "llamacpp-upstream:model").await;
        assert!(first_is_leader);
        assert!(!same_is_leader);
        assert!(other_is_leader);
    }

    #[tokio::test]
    async fn release_allows_a_new_leader() {
        let state = AutoIncreaseState::default();
        let (notify, _) = acquire_slot(&state, "llamacpp:qwen").await;
        release_slot(&state, "llamacpp:qwen", &notify).await;
        let (_next, is_leader) = acquire_slot(&state, "llamacpp:qwen").await;
        assert!(is_leader);
    }

    #[tokio::test]
    async fn outcome_roundtrip() {
        let state = AutoIncreaseState::default();
        let outcome = AutoIncreaseOutcome {
            ok: true,
            new_ctx_len: Some(16_384),
            reason: None,
        };
        store_outcome(&state, "llamacpp:model", outcome).await;
        let stored = read_outcome(&state, "llamacpp:model").await.unwrap();
        assert!(stored.ok);
        assert_eq!(stored.new_ctx_len, Some(16_384));
    }

    #[tokio::test]
    async fn bounded_wait_reports_timeout() {
        let outcome = await_with_deadline(
            std::future::pending(),
            None,
            Duration::from_millis(1),
            "timeout_for_test",
        )
        .await;
        assert!(!outcome.ok);
        assert_eq!(outcome.reason.as_deref(), Some("timeout_for_test"));
    }

    #[tokio::test]
    async fn bounded_wait_honors_cancellation() {
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let outcome = await_with_deadline(
            std::future::pending(),
            Some(&cancellation),
            Duration::from_secs(1),
            "timeout_for_test",
        )
        .await;
        assert!(!outcome.ok);
        assert_eq!(outcome.reason.as_deref(), Some("cancelled"));
    }
}
