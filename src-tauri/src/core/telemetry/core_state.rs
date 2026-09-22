//! What the app's telemetry commands learned, kept so the core can be told.
//!
//! The core reports its own failures to its own Sentry project, under the same
//! `productAnalytic` consent, anonymous device id and zero-PII hardware tags as
//! the app (core ADR `2026-09-21-report-core-errors-to-its-own-sentry-project`).
//! The webview sends them once at start-up and on every change; a core that
//! (re)attaches later must hear them again, so they are kept here.

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::{json, Value};

#[derive(Debug, Default, Clone, PartialEq)]
pub struct CoreTelemetry {
    pub user_id: Option<String>,
    pub tags: HashMap<String, String>,
}

static STATE: Mutex<Option<CoreTelemetry>> = Mutex::new(None);

fn update(change: impl FnOnce(&mut CoreTelemetry)) {
    if let Ok(mut guard) = STATE.lock() {
        change(guard.get_or_insert_with(CoreTelemetry::default));
    }
}

pub fn remember_user(id: &str) {
    update(|state| state.user_id = Some(id.to_string()));
}

pub fn remember_tags(tags: &HashMap<String, String>) {
    update(|state| state.tags = tags.clone());
}

/// The `PUT /atomic/v1/telemetry` body for what is known now.
pub fn current_body() -> Value {
    let state = STATE
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
        .unwrap_or_default();
    body(super::core_consent(), &state)
}

/// The body itself: the consent, the user (`null` until the webview sends one)
/// and the whole tag set, which the core allow-lists again on its side.
pub fn body(enabled: bool, state: &CoreTelemetry) -> Value {
    json!({ "enabled": enabled, "user_id": state.user_id, "tags": state.tags })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_body_carries_consent_user_and_every_tag() {
        let state = CoreTelemetry {
            user_id: Some("device-1".into()),
            tags: HashMap::from([("gpu_model".to_string(), "Apple M3".to_string())]),
        };
        assert_eq!(
            body(true, &state),
            json!({ "enabled": true, "user_id": "device-1", "tags": { "gpu_model": "Apple M3" } })
        );
        assert_eq!(
            body(false, &CoreTelemetry::default()),
            json!({ "enabled": false, "user_id": null, "tags": {} })
        );
    }

    #[test]
    fn what_the_commands_learn_is_kept_for_the_next_core() {
        remember_user("device-2");
        remember_tags(&HashMap::from([("os".to_string(), "macOS 15".to_string())]));
        let sent = current_body();
        assert_eq!(sent["user_id"], "device-2");
        assert_eq!(sent["tags"], json!({ "os": "macOS 15" }));
    }
}
