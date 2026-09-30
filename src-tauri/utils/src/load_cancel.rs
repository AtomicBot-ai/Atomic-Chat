//! Cancelling a model load before the engine reports ready (ATO-530).
//!
//! A load only becomes a session — something `unload` can find — once the
//! server says it is ready, which can be minutes for a large model. Until then
//! the child process is owned by the load future alone, so "stop this model"
//! had nothing to act on. Each engine plugin registers a token per model id
//! for the duration of a load; a cancel command trips it, and the load kills
//! its own child and returns a cancelled error.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub use tokio_util::sync::CancellationToken;

#[derive(Clone, Default)]
pub struct LoadCancelRegistry {
    inner: Arc<Mutex<RegistryInner>>,
}

#[derive(Default)]
struct RegistryInner {
    next_generation: u64,
    loads: HashMap<String, (u64, CancellationToken)>,
}

/// Keeps a model's token registered while the load runs, and removes it on
/// drop — whichever way the load ends.
pub struct LoadCancelGuard {
    registry: LoadCancelRegistry,
    model_id: String,
    generation: u64,
    token: CancellationToken,
}

impl LoadCancelRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a fresh token for `model_id`. A token left behind by an
    /// earlier load of the same model is replaced, not tripped: a cancel is
    /// aimed at the load in flight when it was asked for.
    pub fn register(&self, model_id: &str) -> LoadCancelGuard {
        let token = CancellationToken::new();
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.next_generation += 1;
        let generation = inner.next_generation;
        inner
            .loads
            .insert(model_id.to_string(), (generation, token.clone()));
        LoadCancelGuard {
            registry: self.clone(),
            model_id: model_id.to_string(),
            generation,
            token,
        }
    }

    /// Trips the token of the load in flight for `model_id`. Returns whether
    /// there was one; `false` means the load has not reached the engine yet or
    /// has already finished.
    pub fn cancel(&self, model_id: &str) -> bool {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        match inner.loads.get(model_id) {
            Some((_, token)) => {
                token.cancel();
                true
            }
            None => false,
        }
    }
}

impl LoadCancelGuard {
    pub fn token(&self) -> CancellationToken {
        self.token.clone()
    }
}

impl Drop for LoadCancelGuard {
    fn drop(&mut self) {
        let mut inner = self
            .registry
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        // A newer load of the same model may have registered meanwhile; its
        // token is not ours to remove.
        if matches!(inner.loads.get(&self.model_id), Some((generation, _)) if *generation == self.generation)
        {
            inner.loads.remove(&self.model_id);
        }
    }
}

/// Whether `token` has been tripped. `None` — a caller with no way to cancel,
/// such as the CLI — never is.
pub fn is_load_cancelled(token: &Option<CancellationToken>) -> bool {
    token.as_ref().is_some_and(|t| t.is_cancelled())
}

/// Resolves when `token` is tripped, and never for `None`. For `select!`.
pub async fn load_cancelled(token: &Option<CancellationToken>) {
    match token {
        Some(t) => t.cancelled().await,
        None => std::future::pending::<()>().await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_trips_the_registered_load() {
        let registry = LoadCancelRegistry::new();
        let guard = registry.register("qwen");

        assert!(registry.cancel("qwen"));
        assert!(guard.token().is_cancelled());
    }

    #[test]
    fn cancel_without_a_load_in_flight_reports_nothing_to_cancel() {
        let registry = LoadCancelRegistry::new();

        assert!(!registry.cancel("qwen"));

        drop(registry.register("qwen"));
        assert!(!registry.cancel("qwen"));
    }

    #[test]
    fn a_finished_load_does_not_unregister_a_newer_one() {
        let registry = LoadCancelRegistry::new();
        let first = registry.register("qwen");
        let second = registry.register("qwen");

        drop(first);

        assert!(registry.cancel("qwen"));
        assert!(second.token().is_cancelled());
    }

    #[test]
    fn a_new_load_does_not_inherit_an_earlier_cancel() {
        let registry = LoadCancelRegistry::new();
        let first = registry.register("qwen");
        registry.cancel("qwen");
        drop(first);

        let second = registry.register("qwen");

        assert!(!second.token().is_cancelled());
    }

    #[tokio::test]
    async fn load_cancelled_resolves_once_tripped() {
        let registry = LoadCancelRegistry::new();
        let guard = registry.register("qwen");
        let token = Some(guard.token());

        registry.cancel("qwen");

        // Would hang the test if a tripped token did not resolve.
        load_cancelled(&token).await;
        assert!(is_load_cancelled(&token));
        assert!(!is_load_cancelled(&None));
    }
}
