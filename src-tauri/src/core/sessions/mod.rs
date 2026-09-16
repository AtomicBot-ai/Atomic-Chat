//! Where a model is being served, and who owns the answer.
//!
//! Two halves. `mirror` is the app's copy of the session table of a core process it does not own;
//! `resolver` is the single question-answering surface over every source of sessions — the two
//! llama.cpp plugins, MLX, and that mirror.
//!
//! Deliberately outside `atomic_core`: the resolver has to be reachable from the proxy and the
//! agent on every target the app builds for, while `atomic_core` needs process inspection that only
//! the desktop targets have. Keeping them apart is what lets one resolver serve both the migrated
//! and the un-migrated paths.

pub mod mirror;
pub mod resolver;

use std::sync::Arc;

use tauri::{AppHandle, Manager, Runtime};

use crate::core::state::AppState;
use mirror::CoreSessions;
use resolver::SessionResolver;

/// The app's resolver, or a plugin-only one built on the spot.
///
/// `setup()` installs the real resolver once the plugins and the core client exist. Anything
/// running before that — and any test that never called `setup` — still needs an answer, so it gets
/// a resolver over the same plugin maps with no core attached. That is not a degraded mode: with no
/// core, "read the plugin maps" is the correct and complete answer, and it is exactly what the
/// installed resolver does for a provider the core does not own.
pub fn resolver_for<R: Runtime>(app: &AppHandle<R>, state: &AppState) -> Arc<SessionResolver> {
    if let Some(resolver) = state.session_resolver.get() {
        return Arc::clone(resolver);
    }
    let llamacpp = app
        .state::<tauri_plugin_llamacpp::LlamacppState>()
        .llama_server_process
        .clone();
    let upstream = app
        .state::<tauri_plugin_llamacpp_upstream::LlamacppState>()
        .llama_server_process
        .clone();
    let mlx = app
        .state::<tauri_plugin_mlx::state::MlxState>()
        .mlx_server_process
        .clone();
    Arc::new(SessionResolver::new(
        llamacpp,
        upstream,
        mlx,
        Arc::new(CoreSessions::new()),
    ))
}

/// Where a model is served, asked of whoever owns that provider's sessions.
///
/// The webview's single entry point for this question. It deliberately does not take "who owns
/// it?" as an argument: ownership can change while the app runs, and a webview that decided for
/// itself would sooner or later resolve against the side that no longer holds the model.
#[tauri::command]
pub async fn resolve_local_session<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
    provider: String,
    model_id: String,
) -> Result<Option<resolver::ResolvedSession>, String> {
    let resolver = resolver_for(&app, &state);
    Ok(resolver.find_in(&provider, &model_id).await)
}

/// Every model loaded right now, across every provider.
#[tauri::command]
pub async fn list_local_sessions<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<resolver::ResolvedSession>, String> {
    Ok(resolver_for(&app, &state).served().await)
}
