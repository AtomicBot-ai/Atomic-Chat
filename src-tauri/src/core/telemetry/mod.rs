//! ATO-113: Sentry crash/error telemetry for the desktop app.
//!
//! Desktop-only (never compiled or linked on mobile). Zero-PII by construction:
//! every outgoing event and breadcrumb passes through [`scrub`] in `before_send`
//! / `before_breadcrumb`, and the machine name + IP are stripped. Sending is
//! gated behind the same `productAnalytic` consent as PostHog via a process
//! global `AtomicBool` (default ON) that the frontend keeps in sync through the
//! `set_telemetry_consent` command.

pub mod commands;
pub mod scrub;

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use sentry::protocol::{Breadcrumb, Event, Value};
use sentry::{ClientInitGuard, ClientOptions};

pub use scrub::scrub;

/// Telemetry consent. Defaults ON to match the `productAnalytic` default; the
/// frontend reconciles the real persisted value on startup and on every toggle.
static TELEMETRY_ENABLED: AtomicBool = AtomicBool::new(true);

/// Absolute path to `app.log`, set once during Tauri `setup()` so `before_send`
/// can attach a scrubbed tail to crash/error events.
static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Cap on the `app.log` tail attached to each event. Kept well under Sentry's
/// per-event payload limit while still giving useful crash context.
const LOG_TAIL_BYTES: usize = 50 * 1024;

pub fn set_consent(enabled: bool) {
    TELEMETRY_ENABLED.store(enabled, Ordering::Relaxed);
}

pub fn consent_enabled() -> bool {
    TELEMETRY_ENABLED.load(Ordering::Relaxed)
}

pub fn set_log_path(path: PathBuf) {
    let _ = LOG_PATH.set(path);
}

/// Initialise the Sentry client. Returns `None` (no-op) when no DSN was baked
/// in at build time (e.g. local dev), so the panic hook / log bridge stay inert
/// instead of erroring. The returned guard must be held for the process
/// lifetime (it flushes pending events on drop).
pub fn init() -> Option<ClientInitGuard> {
    let dsn = option_env!("SENTRY_DSN_DESKTOP").unwrap_or("");
    if dsn.is_empty() {
        return None;
    }

    let release = option_env!("SENTRY_RELEASE")
        .filter(|s| !s.is_empty())
        .unwrap_or(env!("CARGO_PKG_VERSION"))
        .to_string();
    let environment = option_env!("SENTRY_ENVIRONMENT")
        .filter(|s| !s.is_empty())
        .unwrap_or("production")
        .to_string();

    let options = ClientOptions {
        release: Some(release.into()),
        environment: Some(environment.into()),
        // Zero-PII: never let the SDK attach IPs, usernames, cookies, etc.
        send_default_pii: false,
        max_breadcrumbs: 50,
        before_send: Some(Arc::new(|event| {
            if !consent_enabled() {
                return None;
            }
            // WS1.5 backstop: drop fingerprint-identical events that repeat within
            // a short window so a runaway `error!` loop cannot flood Sentry even
            // if a call site forgets to throttle.
            if is_duplicate_event(&event) {
                return None;
            }
            if is_transient_network_failure(&event) {
                return None;
            }
            Some(scrub_event(event))
        })),
        before_breadcrumb: Some(Arc::new(|crumb| {
            if !consent_enabled() {
                return None;
            }
            Some(scrub_breadcrumb(crumb))
        })),
        ..Default::default()
    };

    Some(sentry::init((dsn, options)))
}

/// Wrap the `tauri-plugin-log` logger so `log::error!` reaches Sentry (as
/// events) and `log::info!`/`warn!` become breadcrumbs, while stdout / webview
/// / file targets keep working. Safe even when Sentry is disabled (no client =
/// no-op forwarding).
pub fn wrap_logger(dest: Box<dyn log::Log>) -> Box<dyn log::Log> {
    Box::new(sentry::integrations::log::SentryLogger::with_dest(dest))
}

/// WS1.5 backstop window: events whose fingerprint repeats within this span are
/// suppressed. Kept short so genuinely recurring (but spaced-out) failures still
/// surface, while a tight crash/`error!` loop is collapsed to one event.
const EVENT_DEDUP_WINDOW: Duration = Duration::from_secs(60);

static EVENT_DEDUP: OnceLock<Mutex<HashMap<u64, Instant>>> = OnceLock::new();

/// Whether an event is fingerprint-identical to one already sent within
/// [`EVENT_DEDUP_WINDOW`]. Fingerprint = message + logentry + first exception
/// type/value + level. Fails open (never suppresses) on a poisoned lock.
fn is_duplicate_event(event: &Event<'static>) -> bool {
    let mut src = String::new();
    if let Some(msg) = &event.message {
        src.push_str(msg);
    }
    if let Some(logentry) = &event.logentry {
        src.push_str(&logentry.message);
    }
    if let Some(exc) = event.exception.values.first() {
        src.push_str(&exc.ty);
        if let Some(value) = &exc.value {
            src.push_str(value);
        }
    }
    src.push_str(&format!("{:?}", event.level));

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    src.hash(&mut hasher);
    let fingerprint = hasher.finish();

    let map = EVENT_DEDUP.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = match map.lock() {
        Ok(guard) => guard,
        Err(_) => return false,
    };
    let now = Instant::now();
    guard.retain(|_, last| now.duration_since(*last) < EVENT_DEDUP_WINDOW);
    if let Some(last) = guard.get(&fingerprint) {
        if now.duration_since(*last) < EVENT_DEDUP_WINDOW {
            return true;
        }
    }
    guard.insert(fingerprint, now);
    false
}

/// Loggers whose failures are dominated by connectivity, not by app defects.
/// The background update check runs on every launch, so an offline machine or
/// a briefly unreachable release host turns into a steady stream of crash
/// events. A genuinely broken update channel still surfaces: only the
/// connectivity-shaped failures below are dropped.
const TRANSIENT_NETWORK_LOGGERS: &[&str] = &[
    "tauri_plugin_updater",
    "app_lib::core::updater::custom_updater",
];

/// Substrings `reqwest` uses for a request that never reached the server.
const TRANSIENT_NETWORK_MARKERS: &[&str] = &[
    "error sending request",
    "operation timed out",
    "dns error",
    "connection refused",
    "connection reset",
    "network is unreachable",
];

/// Whether an event is an update check that failed for want of a working
/// network connection.
fn is_transient_network_failure(event: &Event<'static>) -> bool {
    let logger = event.logger.as_deref().unwrap_or_default();
    if !TRANSIENT_NETWORK_LOGGERS
        .iter()
        .any(|prefix| logger.starts_with(prefix))
    {
        return false;
    }

    let mut message = String::new();
    if let Some(msg) = &event.message {
        message.push_str(msg);
    }
    if let Some(logentry) = &event.logentry {
        message.push_str(&logentry.message);
    }
    let message = message.to_ascii_lowercase();

    TRANSIENT_NETWORK_MARKERS
        .iter()
        .any(|marker| message.contains(marker))
}

/// Model-load failures all arrive under the same headline ("Error in load
/// command:") with a whole llama.cpp log pasted after it. Sentry groups on that
/// text, so unrelated defects — a shard set opened at the wrong file, a model
/// too big for the machine, a context longer than the model was trained on —
/// landed in one issue, while incidental differences in the log split the same
/// defect across several.
///
/// The engine already classifies the cause and stamps it into the message as a
/// bracketed code. When one is present, group by it.
const LOAD_ERROR_HEADLINE: &str = "Error in load command";

/// Extract the `[SCREAMING_SNAKE_CASE]` code the engine appends to a load
/// failure, if any.
fn load_error_code(message: &str) -> Option<String> {
    let open = message.rfind('[')?;
    let close = message[open..].find(']')? + open;
    let code = &message[open + 1..close];
    if code.is_empty()
        || !code
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
    {
        return None;
    }
    Some(code.to_string())
}

/// Group a model-load failure by its cause rather than by the log text that
/// happens to follow it. Returns `None` for everything else, leaving Sentry's
/// default grouping alone.
fn load_failure_fingerprint(event: &Event<'static>) -> Option<Vec<String>> {
    let mut message = String::new();
    if let Some(msg) = &event.message {
        message.push_str(msg);
    }
    if let Some(logentry) = &event.logentry {
        message.push_str(&logentry.message);
    }
    if !message.contains(LOAD_ERROR_HEADLINE) {
        return None;
    }

    let code = load_error_code(&message).unwrap_or_else(|| "UNCLASSIFIED".to_string());
    Some(vec!["model-load-failure".to_string(), code])
}

/// Strip machine name + IP, scrub every free-text field, and attach a scrubbed
/// `app.log` tail.
fn scrub_event(mut event: Event<'static>) -> Event<'static> {
    if let Some(fingerprint) = load_failure_fingerprint(&event) {
        event.fingerprint = fingerprint
            .into_iter()
            .map(std::borrow::Cow::Owned)
            .collect::<Vec<_>>()
            .into();
    }

    // Machine/host name and any IP are forbidden by the zero-PII doctrine.
    event.server_name = None;
    if let Some(user) = event.user.as_mut() {
        user.ip_address = None;
        user.username = None;
        user.email = None;
    }

    if let Some(msg) = event.message.take() {
        event.message = Some(scrub(&msg));
    }
    if let Some(logentry) = event.logentry.as_mut() {
        logentry.message = scrub(&logentry.message);
    }

    for exception in event.exception.values.iter_mut() {
        if let Some(value) = exception.value.as_mut() {
            *value = scrub(value);
        }
        if let Some(stacktrace) = exception.stacktrace.as_mut() {
            for frame in stacktrace.frames.iter_mut() {
                if let Some(filename) = frame.filename.as_mut() {
                    *filename = scrub(filename);
                }
                if let Some(abs_path) = frame.abs_path.as_mut() {
                    *abs_path = scrub(abs_path);
                }
                // Local variables can capture prompts/paths/tokens verbatim.
                frame.vars.clear();
            }
        }
    }

    scrub_map(&mut event.extra);

    if let Some(tail) = read_log_tail() {
        event
            .extra
            .insert("app_log_tail".to_string(), Value::String(tail));
    }

    event
}

fn scrub_breadcrumb(mut crumb: Breadcrumb) -> Breadcrumb {
    if let Some(message) = crumb.message.as_mut() {
        *message = scrub(message);
    }
    scrub_map(&mut crumb.data);
    crumb
}

fn scrub_value(value: &mut Value) {
    match value {
        Value::String(s) => *s = scrub(s),
        Value::Array(arr) => arr.iter_mut().for_each(scrub_value),
        Value::Object(obj) => obj.values_mut().for_each(scrub_value),
        _ => {}
    }
}

fn scrub_map(map: &mut sentry::protocol::Map<String, Value>) {
    for value in map.values_mut() {
        scrub_value(value);
    }
}

fn read_log_tail() -> Option<String> {
    let path = LOG_PATH.get()?;
    let data = std::fs::read(path).ok()?;
    let start = data.len().saturating_sub(LOG_TAIL_BYTES);
    Some(scrub(&String::from_utf8_lossy(&data[start..])))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(logger: &str, message: &str) -> Event<'static> {
        Event {
            logger: Some(logger.to_string()),
            message: Some(message.to_string()),
            ..Default::default()
        }
    }

    /// Real messages seen in the desktop project, trimmed.
    const SPLIT_SHARD_FAILURE: &str = "Error in load command:\n\
        The model process encountered an unexpected error.\n\
        error loading model: illegal split file idx: 1 (file: /home/x/model.gguf), \
        model must be loaded with the first split [LLAMA_CPP_PROCESS_ERROR]";
    const OOM_FAILURE: &str = "Error in load command:\n\
        Out of memory. The model requires more RAM or VRAM than available.\n\
        failed to allocate CPU_REPACK buffer of size 2167603200 [OUT_OF_MEMORY]";

    #[test]
    fn load_failures_group_by_cause_not_by_log_text() {
        let split = load_failure_fingerprint(&event("webview:error", SPLIT_SHARD_FAILURE));
        let oom = load_failure_fingerprint(&event("webview:error", OOM_FAILURE));

        assert_eq!(
            split,
            Some(vec![
                "model-load-failure".to_string(),
                "LLAMA_CPP_PROCESS_ERROR".to_string()
            ])
        );
        assert_ne!(split, oom, "distinct causes must not share an issue");
    }

    #[test]
    fn the_same_cause_groups_across_differing_logs() {
        // Same defect, different user, different model, different timings.
        let a = load_failure_fingerprint(&event("webview:error", SPLIT_SHARD_FAILURE));
        let b = load_failure_fingerprint(&event(
            "webview:error",
            "Error in load command:\n\
             The model process encountered an unexpected error.\n\
             0.00.253.774 I cmn common_param: verbosity = 3\n\
             error loading model: illegal split file idx: 3 (file: /Users/y/other.gguf), \
             model must be loaded with the first split [LLAMA_CPP_PROCESS_ERROR]",
        ));

        assert_eq!(a, b);
    }

    #[test]
    fn an_unclassified_load_failure_still_gets_its_own_bucket() {
        let fingerprint = load_failure_fingerprint(&event(
            "webview:error",
            "Error in load command:\nsomething we do not classify yet",
        ));

        assert_eq!(
            fingerprint,
            Some(vec![
                "model-load-failure".to_string(),
                "UNCLASSIFIED".to_string()
            ])
        );
    }

    #[test]
    fn other_events_keep_default_grouping() {
        assert_eq!(
            load_failure_fingerprint(&event("app_lib::core::mcp", "Failed to start MCP server")),
            None
        );
    }

    #[test]
    fn a_bracketed_non_code_is_not_mistaken_for_one() {
        // Log lines are full of brackets; only a SCREAMING_SNAKE_CASE token counts.
        assert_eq!(
            load_error_code("Error in load command: [HummingbirdCore] failed"),
            None
        );
        assert_eq!(
            load_error_code("Error in load command: boom [OUT_OF_MEMORY]"),
            Some("OUT_OF_MEMORY".to_string())
        );
    }

    #[test]
    fn drops_offline_update_checks() {
        assert!(is_transient_network_failure(&event(
            "tauri_plugin_updater::updater",
            "failed to check for updates: error sending request for url (https://example.invalid/latest.json)",
        )));
        assert!(is_transient_network_failure(&event(
            "app_lib::core::updater::custom_updater",
            "All 1 endpoints failed, no usable network connection: HTTP request failed: operation timed out",
        )));
    }

    #[test]
    fn keeps_update_failures_that_are_not_connectivity() {
        assert!(!is_transient_network_failure(&event(
            "app_lib::core::updater::custom_updater",
            "All 1 endpoints failed: Invalid response from server: missing signature",
        )));
    }

    #[test]
    fn keeps_network_shaped_failures_from_other_subsystems() {
        assert!(!is_transient_network_failure(&event(
            "app_lib::core::mcp::helpers",
            "Failed to connect to server: error sending request",
        )));
    }
}
