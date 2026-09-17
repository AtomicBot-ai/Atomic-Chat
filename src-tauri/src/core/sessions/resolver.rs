//! The one place the app asks "where is this model being served?".
//!
//! Before the core, the answer came from locking a plugin's session map, and every caller did it
//! themselves — the proxy in nine places, the agent in three, the RAG bridge in one. The inventory
//! for stage 3b (PLAN.md §0) found the cost of that: three separate caches of a port and key, none
//! of which was cleared when a session died, and one of them captured inside a closure that could
//! never be refreshed at all. A model reloaded with a bigger context kept answering on its old port
//! until something happened to notice.
//!
//! So there is now one resolver, and it holds every source: the two llama.cpp plugins, MLX, and the
//! core's mirror. Which source answers for a provider is a single switch — the migration flag —
//! which is also what makes the rollback real: turn the flag off and the same call reads the plugin
//! map again, with no other code changing.
//!
//! Nothing here caches. A resolution is only true for as long as the process behind it lives, and
//! the cost of asking is a mutex on a map with a handful of entries.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};

use tokio::sync::Mutex;

use tauri_plugin_llamacpp::LLamaBackendSession;
use tauri_plugin_llamacpp_upstream::LLamaBackendSession as LLamaUpstreamBackendSession;
use tauri_plugin_mlx::state::MlxBackendSession;

use super::mirror::{CoreSession, CoreSessions};
use crate::core::server::proxy::model_ids_match;

pub const PROVIDER_LLAMACPP: &str = "llamacpp";
pub const PROVIDER_LLAMACPP_UPSTREAM: &str = "llamacpp-upstream";
pub const PROVIDER_MLX: &str = "mlx";
/// Never searched by default — the proxy does not route to it — but the core can own its sessions,
/// and the webview then asks the resolver for them by this name.
pub const PROVIDER_FOUNDATION_MODELS: &str = "foundation-models";

/// Search order for a request that does not name a provider.
///
/// The order the proxy has always used. It matters when the same model id is loaded under two
/// backends: the first one found wins, and changing that would silently redirect traffic.
pub const PROVIDER_SEARCH_ORDER: [&str; 3] =
    [PROVIDER_LLAMACPP, PROVIDER_LLAMACPP_UPSTREAM, PROVIDER_MLX];

/// A resolved session: everything a caller needs to send a request to a running model.
pub type ResolvedSession = CoreSession;

type LlamacppMap = Arc<Mutex<HashMap<i32, LLamaBackendSession>>>;
type UpstreamMap = Arc<Mutex<HashMap<i32, LLamaUpstreamBackendSession>>>;
type MlxMap = Arc<Mutex<HashMap<i32, MlxBackendSession>>>;

pub struct SessionResolver {
    llamacpp: LlamacppMap,
    upstream: UpstreamMap,
    mlx: MlxMap,
    core: Arc<CoreSessions>,
    /// Providers whose sessions the core owns. Everything else is read from its plugin map.
    core_owned: RwLock<HashSet<String>>,
}

impl SessionResolver {
    pub fn new(
        llamacpp: LlamacppMap,
        upstream: UpstreamMap,
        mlx: MlxMap,
        core: Arc<CoreSessions>,
    ) -> Self {
        Self {
            llamacpp,
            upstream,
            mlx,
            core,
            core_owned: RwLock::new(HashSet::new()),
        }
    }

    /// Hand a provider's sessions to the core, or take them back.
    ///
    /// Called when the migration flag changes. Taking them back is the rollback: the plugin map is
    /// still there, still holding whatever the app itself loaded.
    pub fn set_core_owned(&self, providers: impl IntoIterator<Item = String>) {
        *self.core_owned.write().expect("core owned") = providers.into_iter().collect();
    }

    pub fn core_owns(&self, provider: &str) -> bool {
        self.core_owned
            .read()
            .expect("core owned")
            .contains(provider)
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
        if self.core_owns(provider) {
            return self.core.find_by_provider(provider, model_id);
        }
        match provider {
            PROVIDER_LLAMACPP => {
                let guard = self.llamacpp.lock().await;
                guard
                    .values()
                    .find(|s| model_ids_match(&s.info.model_id, model_id))
                    .map(|s| from_llamacpp(&s.info))
            }
            PROVIDER_LLAMACPP_UPSTREAM => {
                let guard = self.upstream.lock().await;
                guard
                    .values()
                    .find(|s| model_ids_match(&s.info.model_id, model_id))
                    .map(|s| from_upstream(&s.info))
            }
            PROVIDER_MLX => {
                let guard = self.mlx.lock().await;
                guard
                    .values()
                    .find(|s| model_ids_match(&s.info.model_id, model_id))
                    .map(|s| from_mlx(&s.info))
            }
            _ => None,
        }
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
        if self.core_owns(provider) {
            return self
                .core
                .list()
                .into_iter()
                .filter(|s| s.provider == provider)
                .collect();
        }
        self.list_legacy_in(provider).await
    }

    /// Read the plugin-owned table even while the resolver is pointed at the core.
    ///
    /// Ownership handover uses this to prove the outgoing legacy runtime is empty before changing
    /// the switch. Normal request paths must use `list_in`, which obeys active ownership.
    pub async fn list_legacy_in(&self, provider: &str) -> Vec<ResolvedSession> {
        match provider {
            PROVIDER_LLAMACPP => self
                .llamacpp
                .lock()
                .await
                .values()
                .map(|s| from_llamacpp(&s.info))
                .collect(),
            PROVIDER_LLAMACPP_UPSTREAM => self
                .upstream
                .lock()
                .await
                .values()
                .map(|s| from_upstream(&s.info))
                .collect(),
            PROVIDER_MLX => self
                .mlx
                .lock()
                .await
                .values()
                .map(|s| from_mlx(&s.info))
                .collect(),
            _ => Vec::new(),
        }
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

fn from_llamacpp(info: &tauri_plugin_llamacpp::state::SessionInfo) -> ResolvedSession {
    ResolvedSession {
        pid: info.pid,
        port: info.port,
        model_id: info.model_id.clone(),
        model_path: info.model_path.clone(),
        is_embedding: info.is_embedding,
        api_key: info.api_key.clone(),
        mmproj_path: info.mmproj_path.clone(),
        provider: PROVIDER_LLAMACPP.to_string(),
    }
}

fn from_upstream(info: &tauri_plugin_llamacpp_upstream::state::SessionInfo) -> ResolvedSession {
    ResolvedSession {
        pid: info.pid,
        port: info.port,
        model_id: info.model_id.clone(),
        model_path: info.model_path.clone(),
        is_embedding: info.is_embedding,
        api_key: info.api_key.clone(),
        mmproj_path: info.mmproj_path.clone(),
        provider: PROVIDER_LLAMACPP_UPSTREAM.to_string(),
    }
}

fn from_mlx(info: &tauri_plugin_mlx::state::SessionInfo) -> ResolvedSession {
    ResolvedSession {
        pid: info.pid,
        port: info.port,
        model_id: info.model_id.clone(),
        model_path: info.model_path.clone(),
        is_embedding: info.is_embedding,
        api_key: info.api_key.clone(),
        // MLX has no projector: vision goes through the model itself.
        mmproj_path: None,
        provider: PROVIDER_MLX.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A plugin session pointing nowhere. The `Child` is a real but inert process because the
    /// plugin's session type owns one; only `info` is ever read here.
    async fn upstream_map(entries: Vec<(&str, i32, bool)>) -> UpstreamMap {
        let mut map = HashMap::new();
        for (index, (model_id, port, is_embedding)) in entries.into_iter().enumerate() {
            let child = tokio::process::Command::new("sleep")
                .arg("120")
                .spawn()
                .expect("spawn placeholder child");
            let pid = index as i32 + 1;
            map.insert(
                pid,
                LLamaUpstreamBackendSession {
                    child,
                    info: tauri_plugin_llamacpp_upstream::state::SessionInfo {
                        pid,
                        port,
                        model_id: model_id.to_string(),
                        model_path: format!("/models/{model_id}.gguf"),
                        is_embedding,
                        api_key: format!("key-{port}"),
                        mmproj_path: None,
                        runtime_device: None,
                    },
                    runtime_device: tauri_plugin_llamacpp_upstream::runtime_device::new_shared(),
                },
            );
        }
        Arc::new(Mutex::new(map))
    }

    fn empty<T>() -> Arc<Mutex<HashMap<i32, T>>> {
        Arc::new(Mutex::new(HashMap::new()))
    }

    fn core_with(sessions: Vec<serde_json::Value>) -> Arc<CoreSessions> {
        let mirror = Arc::new(CoreSessions::new());
        mirror.apply_snapshot(1, "i", &json!({ "sessions": sessions }));
        mirror
    }

    fn core_session(
        model_id: &str,
        port: i32,
        provider: &str,
        is_embedding: bool,
    ) -> serde_json::Value {
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

    async fn resolver(upstream: UpstreamMap, core: Arc<CoreSessions>) -> SessionResolver {
        SessionResolver::new(empty(), upstream, empty(), core)
    }

    #[tokio::test]
    async fn with_the_flag_off_it_answers_from_the_plugin_map() {
        let r = resolver(
            upstream_map(vec![("demo", 3001, false)]).await,
            core_with(vec![]),
        )
        .await;

        let found = r.find("demo").await.expect("resolved");

        assert_eq!(found.port, 3001);
        assert_eq!(found.api_key, "key-3001");
        assert_eq!(found.provider, PROVIDER_LLAMACPP_UPSTREAM);
    }

    #[tokio::test]
    async fn with_the_flag_on_it_answers_from_the_core_and_ignores_the_plugin_map() {
        // The plugin map still holds a stale entry from before the handover; reading it would send
        // traffic to a process the app no longer drives.
        let r = resolver(
            upstream_map(vec![("demo", 3001, false)]).await,
            core_with(vec![core_session(
                "demo",
                4001,
                PROVIDER_LLAMACPP_UPSTREAM,
                false,
            )]),
        )
        .await;
        r.set_core_owned([PROVIDER_LLAMACPP_UPSTREAM.to_string()]);

        assert_eq!(r.find("demo").await.unwrap().port, 4001);
    }

    #[tokio::test]
    async fn handover_can_still_inspect_the_outgoing_legacy_map() {
        let r = resolver(
            upstream_map(vec![("demo", 3001, false)]).await,
            core_with(vec![core_session(
                "demo",
                4001,
                PROVIDER_LLAMACPP_UPSTREAM,
                false,
            )]),
        )
        .await;
        r.set_core_owned([PROVIDER_LLAMACPP_UPSTREAM.to_string()]);

        assert_eq!(
            r.list_legacy_in(PROVIDER_LLAMACPP_UPSTREAM).await[0].port,
            3001
        );
        assert_eq!(r.list_in(PROVIDER_LLAMACPP_UPSTREAM).await[0].port, 4001);
    }

    #[tokio::test]
    async fn turning_the_flag_back_off_restores_the_plugin_map_with_no_other_change() {
        // This is the rollback: the legacy code never stopped holding its own sessions.
        let r = resolver(
            upstream_map(vec![("demo", 3001, false)]).await,
            core_with(vec![core_session(
                "demo",
                4001,
                PROVIDER_LLAMACPP_UPSTREAM,
                false,
            )]),
        )
        .await;
        r.set_core_owned([PROVIDER_LLAMACPP_UPSTREAM.to_string()]);
        assert_eq!(r.find("demo").await.unwrap().port, 4001);

        r.set_core_owned([]);

        assert_eq!(r.find("demo").await.unwrap().port, 3001);
    }

    #[tokio::test]
    async fn a_provider_the_core_does_not_own_still_reads_its_own_map() {
        let r = resolver(
            upstream_map(vec![("demo", 3001, false)]).await,
            core_with(vec![]),
        )
        .await;
        r.set_core_owned([PROVIDER_MLX.to_string()]);

        assert_eq!(
            r.find_in(PROVIDER_LLAMACPP_UPSTREAM, "demo")
                .await
                .unwrap()
                .port,
            3001
        );
        assert!(r.find_in(PROVIDER_MLX, "demo").await.is_none());
    }

    #[tokio::test]
    async fn a_core_session_is_only_returned_for_its_own_provider() {
        let r = resolver(
            empty(),
            core_with(vec![core_session(
                "demo",
                4001,
                PROVIDER_LLAMACPP_UPSTREAM,
                false,
            )]),
        )
        .await;
        r.set_core_owned([
            PROVIDER_LLAMACPP_UPSTREAM.to_string(),
            PROVIDER_LLAMACPP.to_string(),
        ]);

        assert!(r.find_in(PROVIDER_LLAMACPP, "demo").await.is_none());
        assert!(r
            .find_in(PROVIDER_LLAMACPP_UPSTREAM, "demo")
            .await
            .is_some());
    }

    #[tokio::test]
    async fn dots_and_underscores_resolve_the_same_model_on_both_paths() {
        let legacy = resolver(
            upstream_map(vec![("Qwen3.5-9B", 3001, false)]).await,
            core_with(vec![]),
        )
        .await;
        assert_eq!(legacy.find("Qwen3_5-9B").await.unwrap().port, 3001);

        let core = resolver(
            empty(),
            core_with(vec![core_session(
                "Qwen3.5-9B",
                4001,
                PROVIDER_LLAMACPP_UPSTREAM,
                false,
            )]),
        )
        .await;
        core.set_core_owned([PROVIDER_LLAMACPP_UPSTREAM.to_string()]);
        assert_eq!(core.find("Qwen3_5-9B").await.unwrap().port, 4001);
    }

    #[tokio::test]
    async fn served_lists_every_provider_and_says_whether_anything_runs_at_all() {
        let r = resolver(
            upstream_map(vec![("a", 3001, false), ("b", 3002, false)]).await,
            core_with(vec![]),
        )
        .await;

        let served = r.served().await;
        assert_eq!(served.len(), 2);
        assert!(r.any_loaded().await);

        let idle = resolver(empty(), core_with(vec![])).await;
        assert!(idle.served().await.is_empty());
        assert!(!idle.any_loaded().await);
    }

    #[tokio::test]
    async fn an_emptied_mirror_reports_nothing_rather_than_a_port_that_died_with_the_core() {
        let mirror = core_with(vec![core_session(
            "demo",
            4001,
            PROVIDER_LLAMACPP_UPSTREAM,
            false,
        )]);
        let r = resolver(empty(), Arc::clone(&mirror)).await;
        r.set_core_owned([PROVIDER_LLAMACPP_UPSTREAM.to_string()]);

        mirror.invalidate(1);

        assert!(r.find("demo").await.is_none());
        assert!(!r.any_loaded().await);
    }

    #[tokio::test]
    async fn the_preferred_embedding_model_wins_even_when_another_provider_has_one_loaded() {
        // The order that matters: a fallback in the first provider must not beat the preferred
        // model in the second, or embeddings would silently go to the wrong model.
        let llamacpp = {
            let mut map = HashMap::new();
            let child = tokio::process::Command::new("sleep")
                .arg("120")
                .spawn()
                .unwrap();
            map.insert(
                1,
                LLamaBackendSession {
                    child,
                    info: tauri_plugin_llamacpp::state::SessionInfo {
                        pid: 1,
                        port: 3100,
                        model_id: "sentence-transformer-mini".to_string(),
                        model_path: "/models/stm.gguf".to_string(),
                        is_embedding: true,
                        api_key: "key-3100".to_string(),
                        mmproj_path: None,
                        runtime_device: None,
                    },
                    runtime_device: tauri_plugin_llamacpp::runtime_device::new_shared(),
                },
            );
            Arc::new(Mutex::new(map))
        };
        let r = SessionResolver::new(
            llamacpp,
            upstream_map(vec![("bge", 3002, true)]).await,
            empty(),
            core_with(vec![]),
        );

        assert_eq!(
            r.find_embedding("sentence-transformer-mini")
                .await
                .unwrap()
                .port,
            3100
        );
    }

    #[tokio::test]
    async fn the_preferred_embedding_model_wins_and_a_text_model_never_does() {
        let r = resolver(
            upstream_map(vec![
                ("text", 3001, false),
                ("bge", 3002, true),
                ("sentence-transformer-mini", 3003, true),
            ])
            .await,
            core_with(vec![]),
        )
        .await;

        assert_eq!(
            r.find_embedding("sentence-transformer-mini")
                .await
                .unwrap()
                .port,
            3003
        );

        let without_preferred = resolver(
            upstream_map(vec![("text", 3001, false), ("bge", 3002, true)]).await,
            core_with(vec![]),
        )
        .await;
        assert_eq!(
            without_preferred
                .find_embedding("sentence-transformer-mini")
                .await
                .unwrap()
                .port,
            3002
        );

        let text_only = resolver(
            upstream_map(vec![("text", 3001, false)]).await,
            core_with(vec![]),
        )
        .await;
        assert!(text_only
            .find_embedding("sentence-transformer-mini")
            .await
            .is_none());
    }
}
