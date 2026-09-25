//! The one place the app asks "where is this model being served?".
//!
//! Before the core, the answer came from locking a plugin's session map, and every caller did it
//! themselves — the proxy in nine places, the agent in three, the RAG bridge in one. Stage 3b put
//! one resolver in front of all of them; stage 6 (PLAN.md §4) removed the plugin maps from it. The
//! core owns every local runtime now, so the answer is the app's mirror of the core's session
//! table, and nothing else.
//!
//! The mirror is emptied whenever the attachment goes, so a model never resolves to a port that
//! died with its core. On mobile no core runs; the mirror stays empty and only cloud providers
//! route.
//!
//! Nothing here caches. A resolution is only true for as long as the process behind it lives.

use std::sync::Arc;

use super::mirror::{CoreSession, CoreSessions};
use crate::core::server::proxy::model_ids_match;

pub const PROVIDER_LLAMACPP: &str = "llamacpp";
pub const PROVIDER_LLAMACPP_UPSTREAM: &str = "llamacpp-upstream";
pub const PROVIDER_MLX: &str = "mlx";
/// Never searched by default — the proxy does not route to it — but the webview asks the resolver
/// for its sessions by this name.
pub const PROVIDER_FOUNDATION_MODELS: &str = "foundation-models";

/// Search order for a request that does not name a provider.
///
/// The order the proxy has always used. It matters when the same model id is loaded under two
/// backends: the first one found wins, and changing that would silently redirect traffic.
pub const PROVIDER_SEARCH_ORDER: [&str; 3] =
    [PROVIDER_LLAMACPP, PROVIDER_LLAMACPP_UPSTREAM, PROVIDER_MLX];

/// A resolved session: everything a caller needs to send a request to a running model.
pub type ResolvedSession = CoreSession;

pub struct SessionResolver {
    core: Arc<CoreSessions>,
}

impl SessionResolver {
    pub fn new(core: Arc<CoreSessions>) -> Self {
        Self { core }
    }

    /// Where a model is served, searching every provider in the established order.
    pub async fn find(&self, model_id: &str) -> Option<ResolvedSession> {
        for provider in PROVIDER_SEARCH_ORDER {
            if let Some(session) = self.find_in(provider, model_id).await {
                return Some(session);
            }
        }
        None
    }

    /// Where a model is served by one specific provider.
    pub async fn find_in(&self, provider: &str, model_id: &str) -> Option<ResolvedSession> {
        self.core.find_by_provider(provider, model_id)
    }

    /// Everything currently loaded, across every provider — what `GET /models` answers with.
    pub async fn served(&self) -> Vec<ResolvedSession> {
        let mut all = Vec::new();
        for provider in PROVIDER_SEARCH_ORDER {
            all.extend(self.list_in(provider).await);
        }
        all
    }

    pub async fn list_in(&self, provider: &str) -> Vec<ResolvedSession> {
        self.core
            .list()
            .into_iter()
            .filter(|s| s.provider == provider)
            .collect()
    }

    /// Whether anything at all is loaded — the proxy tells "no models running" (503) from "that
    /// model is not loaded" (404) with this.
    pub async fn any_loaded(&self) -> bool {
        for provider in PROVIDER_SEARCH_ORDER {
            if !self.list_in(provider).await.is_empty() {
                return true;
            }
        }
        false
    }

    /// A session that can produce embeddings, preferring `preferred` when it is loaded.
    ///
    /// The preferred model wins wherever it is running — only if it is running nowhere does the
    /// first embedding session in provider order do instead. Checking one provider's fallback
    /// before another provider's preferred model would quietly send embeddings to the wrong model
    /// whenever both were loaded.
    ///
    /// Upstream is first because it is the provider the bundled embedding model ships for.
    pub async fn find_embedding(&self, preferred: &str) -> Option<ResolvedSession> {
        const ORDER: [&str; 3] = [PROVIDER_LLAMACPP_UPSTREAM, PROVIDER_LLAMACPP, PROVIDER_MLX];
        let mut loaded = Vec::new();
        for provider in ORDER {
            loaded.extend(
                self.list_in(provider)
                    .await
                    .into_iter()
                    .filter(|s| s.is_embedding),
            );
        }
        loaded
            .iter()
            .find(|s| model_ids_match(&s.model_id, preferred))
            .cloned()
            .or_else(|| loaded.into_iter().next())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn core_with(sessions: Vec<serde_json::Value>) -> Arc<CoreSessions> {
        let mirror = Arc::new(CoreSessions::new());
        mirror.apply_snapshot(1, "i", &json!({ "sessions": sessions }));
        mirror
    }

    fn session(model_id: &str, port: i32, provider: &str, is_embedding: bool) -> serde_json::Value {
        json!({
            "pid": 900,
            "port": port,
            "model_id": model_id,
            "model_path": format!("/models/{model_id}.gguf"),
            "is_embedding": is_embedding,
            "api_key": format!("core-key-{port}"),
            "provider": provider,
        })
    }

    #[tokio::test]
    async fn it_answers_from_the_core_mirror_for_the_named_provider_only() {
        let r = SessionResolver::new(core_with(vec![
            session("demo", 3001, PROVIDER_LLAMACPP_UPSTREAM, false),
            session("qwen", 3002, PROVIDER_MLX, false),
            session("apple/on-device", 3003, PROVIDER_FOUNDATION_MODELS, false),
        ]));

        assert_eq!(r.find_in(PROVIDER_LLAMACPP_UPSTREAM, "demo").await.unwrap().port, 3001);
        assert!(r.find_in(PROVIDER_LLAMACPP, "demo").await.is_none());
        assert_eq!(r.find_in(PROVIDER_FOUNDATION_MODELS, "apple/on-device").await.unwrap().api_key, "core-key-3003");
        assert_eq!(r.find("qwen").await.unwrap().provider, PROVIDER_MLX);
        // Foundation Models is never searched without naming it: the proxy does not route to it.
        assert!(r.find("apple/on-device").await.is_none());
    }

    #[tokio::test]
    async fn dots_and_underscores_resolve_the_same_model() {
        let r = SessionResolver::new(core_with(vec![session("qwen3.5", 3001, PROVIDER_LLAMACPP, false)]));
        assert_eq!(r.find("qwen3_5").await.unwrap().port, 3001);
    }

    #[tokio::test]
    async fn served_lists_every_searched_provider_and_says_whether_anything_runs() {
        let r = SessionResolver::new(core_with(vec![
            session("a", 3001, PROVIDER_LLAMACPP, false),
            session("b", 3002, PROVIDER_MLX, false),
            session("apple/on-device", 3003, PROVIDER_FOUNDATION_MODELS, false),
        ]));
        assert_eq!(r.served().await.len(), 2);
        assert!(r.any_loaded().await);
        assert!(!SessionResolver::new(core_with(vec![])).any_loaded().await);
    }

    #[tokio::test]
    async fn an_emptied_mirror_reports_nothing_rather_than_a_port_that_died_with_the_core() {
        let core = core_with(vec![session("demo", 3001, PROVIDER_LLAMACPP_UPSTREAM, false)]);
        let r = SessionResolver::new(Arc::clone(&core));
        core.invalidate(1);
        assert!(r.find("demo").await.is_none());
        assert!(!r.any_loaded().await);
    }

    #[tokio::test]
    async fn the_preferred_embedding_model_wins_across_providers_and_a_text_model_never_does() {
        let r = SessionResolver::new(core_with(vec![
            session("bge", 3002, PROVIDER_LLAMACPP_UPSTREAM, true),
            session("sentence-transformer-mini", 3100, PROVIDER_LLAMACPP, true),
            session("text", 3001, PROVIDER_LLAMACPP_UPSTREAM, false),
        ]));
        assert_eq!(r.find_embedding("sentence-transformer-mini").await.unwrap().port, 3100);
        let fallback = SessionResolver::new(core_with(vec![
            session("text", 3001, PROVIDER_LLAMACPP_UPSTREAM, false),
            session("bge", 3002, PROVIDER_LLAMACPP_UPSTREAM, true),
        ]));
        assert_eq!(fallback.find_embedding("sentence-transformer-mini").await.unwrap().port, 3002);
        let text_only = SessionResolver::new(core_with(vec![session("text", 3001, PROVIDER_LLAMACPP, false)]));
        assert!(text_only.find_embedding("sentence-transformer-mini").await.is_none());
    }
}
