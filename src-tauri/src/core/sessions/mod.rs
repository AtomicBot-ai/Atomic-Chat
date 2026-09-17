//! Where a model is being served, and who owns the answer.
//!
//! Two halves. `mirror` is the app's copy of the session table of the core process that owns every
//! local runtime; `resolver` is the single question-answering surface over it.
//!
//! Deliberately outside `atomic_core`: the resolver has to be reachable from the proxy and the
//! agent on every target the app builds for, while `atomic_core` needs process inspection that only
//! the desktop targets have. On mobile the resolver answers over an empty mirror.

pub mod mirror;
pub mod resolver;

use std::sync::Arc;

use tauri::{AppHandle, Runtime};

use crate::core::state::AppState;
use mirror::CoreSessions;
use resolver::SessionResolver;

/// The app's resolver, or one over an empty mirror.
///
/// `setup()` installs the real resolver over the core client's mirror. Anything running before that,
/// any test that never called `setup`, and mobile — where no core runs — get a resolver that finds
/// nothing local, which is the truth for them.
pub fn resolver_for<R: Runtime>(_app: &AppHandle<R>, state: &AppState) -> Arc<SessionResolver> {
    if let Some(resolver) = state.session_resolver.get() {
        return Arc::clone(resolver);
    }
    Arc::new(SessionResolver::new(Arc::new(CoreSessions::new())))
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

/// Every model loaded right now, across every provider — Foundation Models included, which the
/// proxy never routes to but the tray still shows.
#[tauri::command]
pub async fn list_local_sessions<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<resolver::ResolvedSession>, String> {
    let resolver = resolver_for(&app, &state);
    let mut sessions = resolver.served().await;
    sessions.extend(resolver.list_in(resolver::PROVIDER_FOUNDATION_MODELS).await);
    Ok(sessions)
}
