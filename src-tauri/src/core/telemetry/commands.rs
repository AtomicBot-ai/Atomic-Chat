//! Tauri commands the frontend uses to keep the Rust Sentry client in sync with
//! the `productAnalytic` consent toggle and to push the same zero-PII hardware
//! tags it sends to its own Sentry project. The core, which reports its own
//! errors to its own project, is told the same three things.

use std::collections::HashMap;

use tauri::{AppHandle, Runtime};

/// Mirror the `productAnalytic` consent into the Rust telemetry gate. Called by
/// the frontend on startup (with the persisted value) and on every toggle.
#[tauri::command]
pub fn set_telemetry_consent<R: Runtime>(app: AppHandle<R>, enabled: bool) {
    super::set_consent(enabled);
    crate::core::atomic_core::telemetry::push(&app);
}

/// Set zero-PII tags (hardware/backend/model context) on the global Sentry
/// scope so Rust crash events carry the same context as the frontend. The
/// frontend only ever passes allow-listed, non-PII values (no GPU UUID/serial,
/// no hostname, no username).
#[tauri::command]
pub fn set_telemetry_context<R: Runtime>(app: AppHandle<R>, tags: HashMap<String, String>) {
    super::core_state::remember_tags(&tags);
    sentry::configure_scope(|scope| {
        for (key, value) in tags {
            scope.set_tag(&key, value);
        }
    });
    crate::core::atomic_core::telemetry::push(&app);
}

/// Attach the anonymous device id the frontend already uses as its Sentry user.
/// Without it every Rust crash reports "0 users impacted", which makes the
/// desktop issue list impossible to prioritise. The id is the PostHog distinct
/// id — a random, non-identifying value, so the zero-PII doctrine holds.
#[tauri::command]
pub fn set_telemetry_user<R: Runtime>(app: AppHandle<R>, id: String) {
    if id.is_empty() {
        return;
    }
    super::core_state::remember_user(&id);
    sentry::configure_scope(|scope| {
        scope.set_user(Some(sentry::User {
            id: Some(id.clone()),
            ..Default::default()
        }));
    });
    crate::core::atomic_core::telemetry::push(&app);
}
