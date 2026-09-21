//! The app's error-reporting consent, anonymous user and hardware tags, told to
//! the core (core ADR `2026-09-21-report-core-errors-to-its-own-sentry-project`).
//!
//! The core reports its own failures — its crashes, engines that die, models
//! that fail to load from any caller — to its own Sentry project, and only under
//! the app's `productAnalytic` consent. It hears that consent at launch
//! (`daemon --telemetry on|off`, see `launch.rs`) and then over
//! `PUT /atomic/v1/telemetry` on every change and after every (re)attach.

use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};

pub const PATH: &str = "/telemetry";

/// Tell the core that is attached right now. Fire and forget, and never a reason
/// to start one: a core that missed it is told again when its snapshot arrives.
pub fn push<R: Runtime>(app: &AppHandle<R>) {
    let body = crate::core::telemetry::core_state::current_body();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(client) = app.try_state::<super::commands::AtomicCoreClient>() else {
            return;
        };
        if !client.is_enabled() {
            return;
        }
        if let Err(error) = client.call_attached("PUT", PATH, Some(body)).await {
            log::debug!(
                "[atomic-core] could not tell the core about error reporting: {}",
                error.message
            );
        }
    });
}

/// What the core answers `GET /telemetry` with, reduced to what a test checks.
pub fn consent_of(state: &Value) -> Option<bool> {
    state.get("enabled").and_then(Value::as_bool)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::telemetry::core_state::{body, CoreTelemetry};
    use serde_json::json;
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};

    #[test]
    fn reads_the_consent_the_core_holds() {
        assert_eq!(
            consent_of(&json!({ "enabled": true, "reporting": false })),
            Some(true)
        );
        assert_eq!(consent_of(&json!({})), None);
    }

    fn launch_tail(consent: bool) -> Vec<String> {
        let command = super::super::launch::CoreCommand {
            program: "core".into(),
            prefix: vec![],
            resources_dir: None,
            cloudflared_bin: None,
        };
        let args = command.daemon_args(Path::new("/data"), consent);
        args[args.len() - 2..].to_vec()
    }

    #[test]
    fn the_launch_flag_is_the_last_pair_of_the_argv() {
        assert_eq!(launch_tail(true), vec!["--telemetry", "on"]);
        assert_eq!(launch_tail(false), vec!["--telemetry", "off"]);
    }

    fn repo_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .canonicalize()
            .unwrap()
    }

    fn git_head(root: &Path) -> String {
        std::process::Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(root)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_else(|| "unknown".to_string())
    }

    /// `cargo test -- --ignored atomic_core::telemetry::tests::dump_fixtures`, then the core's
    /// `scripts/import-app-fixtures.mjs`. The core replays them in `test/contract/telemetry.test.ts`.
    #[test]
    #[ignore]
    fn dump_fixtures() {
        let root = repo_root();
        let out = root.join("tests/fixtures/core-contracts/telemetry");
        let _ = std::fs::remove_dir_all(&out);
        std::fs::create_dir_all(&out).unwrap();
        let commit = git_head(&root);
        let source = "src-tauri/src/core/atomic_core/{launch,telemetry}.rs";

        let tags = HashMap::from([
            ("app_version".to_string(), "2.0.42".to_string()),
            ("platform".to_string(), "macos".to_string()),
            ("gpu_model".to_string(), "Apple M3 Max".to_string()),
            ("vram_mb".to_string(), "36864".to_string()),
        ]);
        let cases: Vec<(&str, Value, Value)> = vec![
            (
                "launch_consent_on",
                json!({ "op": "launch", "consent": true }),
                json!({ "argv_tail": launch_tail(true) }),
            ),
            (
                "launch_consent_off",
                json!({ "op": "launch", "consent": false }),
                json!({ "argv_tail": launch_tail(false) }),
            ),
            (
                "update_consent_user_and_tags",
                json!({ "op": "update", "consent": true, "user_id": "device-1", "tags": tags }),
                json!({ "body": body(true, &CoreTelemetry { user_id: Some("device-1".into()), tags: tags.clone() }) }),
            ),
            (
                "update_before_the_webview_reports",
                json!({ "op": "update", "consent": true, "user_id": null, "tags": {} }),
                json!({ "body": body(true, &CoreTelemetry::default()) }),
            ),
            (
                "update_consent_withdrawn",
                json!({ "op": "update", "consent": false, "user_id": "device-1", "tags": tags }),
                json!({ "body": body(false, &CoreTelemetry { user_id: Some("device-1".into()), tags: tags.clone() }) }),
            ),
        ];

        let mut names = Vec::new();
        for (name, input, expected) in cases {
            let doc = json!({
                "name": name,
                "source": { "file": source, "commit": commit },
                "comparator": "telemetry-wire",
                "input": input,
                "expected": expected,
            });
            std::fs::write(
                out.join(format!("{name}.json")),
                serde_json::to_string_pretty(&doc).unwrap() + "\n",
            )
            .unwrap();
            names.push(name);
        }
        let index = json!({
            "cases": names,
            "comparator": "telemetry-wire",
            "comparator_notes": {
                "telemetry-wire": "op=launch: expected.argv_tail is the last two arguments of `daemon`; the core must accept them and take the consent from the second (on/off). op=update: expected.body is exactly what the app PUTs to /atomic/v1/telemetry (enabled, user_id or null, every tag the webview sent); the core must accept it and answer enabled = body.enabled, has_user = user_id is not null, and the tags restricted to its allow-list."
            },
            "source": { "file": source, "commit": commit },
        });
        std::fs::write(
            out.join("index.json"),
            serde_json::to_string_pretty(&index).unwrap() + "\n",
        )
        .unwrap();
    }
}
