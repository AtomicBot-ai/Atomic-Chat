//! Who serves the Local API — the app's own proxy or `atomic-chat-core` — and
//! how it moves from one to the other (PLAN.md §4 stage 4e, §2 decision 12).
//!
//! `start_server`, `stop_server` and `get_server_status` keep their names and
//! payloads; the webview does not know which process answers. Behind them sits
//! one `PublicApiOwner`, chosen by the persisted `atomic_core.server` flag.
//!
//! A handover is serialised and never leaves two listeners fighting for the
//! port, nor none without saying so:
//!   1. if nothing is serving, only the flag changes;
//!   2. the outgoing owner stops first, which frees the port;
//!   3. the incoming owner starts with the configuration the webview last used;
//!   4. if that fails, the outgoing owner is started again — and if even that
//!      fails, the server is left stopped and the error says so.
//!
//! Exactly one side writes `<data>/local-api-server.json` at a time: the app's
//! proxy while it owns the server, the core (`state_file: true`) while the core
//! does. The control API is never touched by any of this.

use std::sync::Mutex as StdMutex;

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::core::atomic_core::client::CoreError;

/// What the webview sends to `start_server`.
#[derive(serde::Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct StartServerConfig {
    pub host: String,
    pub port: u16,
    pub prefix: String,
    pub api_key: String,
    pub trusted_hosts: Vec<String>,
    pub proxy_timeout: u64,
}

/// The configuration of the last `start_server` call, so a handover can bring
/// the server up on the other side exactly as the user configured it.
static LAST_CONFIG: StdMutex<Option<StartServerConfig>> = StdMutex::new(None);

pub fn remember_config(config: &StartServerConfig) {
    if let Ok(mut last) = LAST_CONFIG.lock() {
        *last = Some(config.clone());
    }
}

pub fn last_config() -> Option<StartServerConfig> {
    LAST_CONFIG.lock().ok().and_then(|last| last.clone())
}

#[async_trait]
pub trait PublicApiOwner: Send + Sync {
    fn label(&self) -> &'static str;
    /// The port it serves on, or `None` when it is not serving.
    async fn running_port(&self) -> Result<Option<u16>, String>;
    async fn start(&self, config: &StartServerConfig) -> Result<u16, String>;
    async fn stop(&self) -> Result<(), String>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Handover {
    /// Nothing was serving; only the owner flag changes.
    NotRunning,
    /// The server now runs on the new owner, on this port.
    Moved(u16),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandoverError {
    pub message: String,
    /// `true`: the previous owner serves again (or never stopped). `false`: the
    /// server is stopped, and the webview must show it as stopped.
    pub restored: bool,
    /// False when a lost response also made the actual listener state unknowable.
    pub confirmed: bool,
}

impl std::fmt::Display for HandoverError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if !self.confirmed {
            write!(f, "{} The Local API Server state is unknown; no second listener was started.", self.message)
        } else if self.restored {
            write!(f, "{} The previous server was restored.", self.message)
        } else {
            write!(f, "{} The Local API Server is now stopped.", self.message)
        }
    }
}

pub async fn hand_over(
    from: &dyn PublicApiOwner,
    to: &dyn PublicApiOwner,
    config: Option<&StartServerConfig>,
) -> Result<Handover, HandoverError> {
    let running = from.running_port().await.map_err(|e| HandoverError {
        message: format!(
            "Could not tell whether the {} server is running: {e}.",
            from.label()
        ),
        restored: false,
        confirmed: false,
    })?;
    if running.is_none() {
        return Ok(Handover::NotRunning);
    }
    let Some(config) = config else {
        return Err(HandoverError {
            message: "The running server's configuration is unknown, so it cannot be moved.".into(),
            restored: true,
            confirmed: true,
        });
    };
    if let Err(error) = from.stop().await {
        let message = format!(
            "Could not confirm stopping the {} server: {}.",
            from.label(), error.trim_end_matches('.')
        );
        match from.running_port().await {
            Ok(None) => {} // The mutation took effect despite its lost response.
            Ok(Some(_)) => return Err(HandoverError { message, restored: true, confirmed: true }),
            Err(status) => return Err(HandoverError {
                message: format!("{message} Rechecking its status failed: {status}."),
                restored: false,
                confirmed: false,
            }),
        }
    }
    match to.start(config).await {
        Ok(port) => Ok(Handover::Moved(port)),
        Err(start_error) => {
            let message = format!(
                "The {} server did not start: {}.",
                to.label(),
                start_error.trim_end_matches('.')
            );
            // A mutation can take effect before its reply is lost, and even its
            // compensating stop can lose a reply. Never resurrect the outgoing
            // listener until the incoming one is positively known to be down.
            match to.running_port().await {
                Ok(Some(port)) => return Err(HandoverError {
                    message: format!("{message} The incoming server still serves on port {port}."),
                    restored: false,
                    confirmed: false,
                }),
                Err(status) => return Err(HandoverError {
                    message: format!("{message} Rechecking the incoming server failed: {status}."),
                    restored: false,
                    confirmed: false,
                }),
                Ok(None) => {},
            }
            match from.start(config).await {
                Ok(_) => Err(HandoverError {
                    message,
                    restored: true,
                    confirmed: true,
                }),
                Err(restart_error) => Err(HandoverError {
                    message: format!(
                        "{message} Restarting the {} server failed too: {}.",
                        from.label(),
                        restart_error.trim_end_matches('.')
                    ),
                    restored: false,
                    confirmed: true,
                }),
            }
        }
    }
}

/// One control API call; the core owner does not care how it is carried.
#[async_trait]
pub trait ControlCaller: Send + Sync {
    async fn call(&self, method: &str, path: &str, body: Option<Value>)
        -> Result<Value, CoreError>;
}

/// The core as the server owner.
pub struct CoreOwner<C: ControlCaller> {
    pub caller: C,
    /// App-owned sessions to publish before opening the listener.
    pub external_sessions: Vec<Value>,
    pub external_generation: u64,
    /// Provider registrations to hand the core before it starts serving, so no
    /// cloud model is lost in the move: `(provider, control API body)`.
    pub providers: Vec<(String, Value)>,
}

/// The `/server/start` body for a configuration. The core writes the app's
/// state file while it owns the server, and falls back to a free port the way
/// the app's proxy does.
pub fn core_start_body(config: &StartServerConfig) -> Value {
    json!({
        "host": config.host,
        "port": config.port,
        "prefix": config.prefix,
        "api_key": config.api_key,
        "trusted_hosts": config.trusted_hosts,
        "proxy_timeout_secs": config.proxy_timeout,
        "state_file": true,
        "fallback_port": true,
    })
}

fn segment(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}

#[async_trait]
impl<C: ControlCaller> PublicApiOwner for CoreOwner<C> {
    fn label(&self) -> &'static str {
        "Atomic Chat core"
    }

    async fn running_port(&self) -> Result<Option<u16>, String> {
        let state = self
            .caller
            .call("GET", "/server", None)
            .await
            .map_err(|e| e.message)?;
        Ok(match state.get("running").and_then(Value::as_bool) {
            Some(true) => state
                .get("port")
                .and_then(Value::as_u64)
                .and_then(|p| u16::try_from(p).ok()),
            _ => None,
        })
    }

    async fn start(&self, config: &StartServerConfig) -> Result<u16, String> {
        // A listener that was already running does not belong to this handover.
        // In particular, a lost /server/start response may be rolled back below
        // only if we observed it stopped before issuing that mutation.
        if self.running_port().await?.is_some() {
            return Err("the core public server is already running".into());
        }
        self.caller
            .call(
                "PUT",
                "/external-sessions/atomic-chat-app",
                Some(json!({
                    "generation": self.external_generation,
                    "sessions": self.external_sessions,
                })),
            )
            .await
            .map_err(|e| format!("could not publish app-owned sessions: {}", e.message))?;
        let mut server_start_attempted = false;
        let result = async {
            for (provider, body) in &self.providers {
                self.caller
                    .call(
                        "PUT",
                        &format!("/cloud/providers/{}", segment(provider)),
                        Some(body.clone()),
                    )
                    .await
                    .map_err(|e| {
                        format!(
                            "could not hand provider {provider} to the core: {}",
                            e.message
                        )
                    })?;
            }
            // Legacy has finished its work after handover stopped its listener.
            // Reload the shared app-scope token file before accepting any request.
            self.caller
                .call("POST", "/auth/chatgpt/reload", None)
                .await
                .map_err(|e| format!("could not reload the ChatGPT session: {}", e.message))?;
            server_start_attempted = true;
            let state = match self
                .caller
                .call("POST", "/server/start", Some(core_start_body(config)))
                .await
            {
                Ok(state) => state,
                Err(error) => {
                    // A semantic refusal proves this call did not open a listener.
                    // In particular, AlreadyRunning belongs to somebody else;
                    // rollback must never stop that listener.
                    if !error.is_unreachable() {
                        server_start_attempted = false;
                    }
                    return Err(error.message);
                }
            };
            state
                .get("port")
                .and_then(Value::as_u64)
                .and_then(|p| u16::try_from(p).ok())
                .ok_or_else(|| "the core did not report the port it bound".to_string())
        }
        .await;
        let original = match result {
            Ok(port) => return Ok(port),
            Err(error) => error,
        };
        if server_start_attempted {
            // A lost response to the mutating start call is ambiguous: it
            // may have opened the listener. Do not remove its models until
            // the listener is known to be down.
            match self.running_port().await {
                Ok(Some(_)) => self
                    .caller
                    .call("POST", "/server/stop", None)
                    .await
                    .map_err(|e| {
                        format!(
                            "{original}; could not roll back the core server: {}",
                            e.message
                        )
                    })?,
                Ok(None) => json!(null),
                Err(error) => {
                    return Err(format!(
                        "{original}; core server status is unknown: {error}"
                    ))
                }
            };
        }
        // A failed handover must not leave app-owned models visible in a core
        // whose public server never became the owner. The generation also
        // protects a newer attachment from a late rollback.
        self.caller
            .call(
                "DELETE",
                "/external-sessions/atomic-chat-app",
                Some(json!({
                    "generation": self.external_generation,
                })),
            )
            .await
            .map_err(|e| {
                format!(
                    "{original}; could not withdraw app-owned sessions: {}",
                    e.message
                )
            })?;
        Err(original)
    }

    async fn stop(&self) -> Result<(), String> {
        if let Err(error) = self.caller.call("POST", "/server/stop", None).await {
            if !error.is_unreachable() {
                return Err(error.message);
            }
            match self.running_port().await {
                Ok(None) => {} // Stop applied; still withdraw the external sessions.
                Ok(Some(_)) => return Err(error.message),
                Err(status) => return Err(format!("{}; server status is unknown: {status}", error.message)),
            }
        }
        self.caller
            .call(
                "DELETE",
                "/external-sessions/atomic-chat-app",
                Some(json!({
                    "generation": self.external_generation,
                })),
            )
            .await
            .map_err(|e| e.message)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    #[derive(Default)]
    struct Fake {
        label: &'static str,
        running: Mutex<Option<u16>>,
        fail_start: bool,
        fail_stop: bool,
        lost_stop_response: bool,
        fail_status: bool,
        log: Arc<Mutex<Vec<String>>>,
    }

    #[async_trait]
    impl PublicApiOwner for Fake {
        fn label(&self) -> &'static str {
            self.label
        }
        async fn running_port(&self) -> Result<Option<u16>, String> {
            if self.fail_status { return Err("status unreachable".into()); }
            Ok(*self.running.lock().await)
        }
        async fn start(&self, config: &StartServerConfig) -> Result<u16, String> {
            self.log.lock().await.push(format!("{} start", self.label));
            if self.fail_start {
                return Err("port refused".into());
            }
            *self.running.lock().await = Some(config.port);
            Ok(config.port)
        }
        async fn stop(&self) -> Result<(), String> {
            self.log.lock().await.push(format!("{} stop", self.label));
            if self.fail_stop {
                return Err("stuck".into());
            }
            *self.running.lock().await = None;
            if self.lost_stop_response { return Err("lost stop response".into()); }
            Ok(())
        }
    }

    fn config() -> StartServerConfig {
        StartServerConfig {
            host: "127.0.0.1".into(),
            port: 1337,
            prefix: "/v1".into(),
            api_key: "k".into(),
            trusted_hosts: vec!["lan".into()],
            proxy_timeout: 600,
        }
    }

    fn pair(
        from_running: bool,
        fail_to: bool,
        fail_back: bool,
    ) -> (Fake, Fake, Arc<Mutex<Vec<String>>>) {
        let log = Arc::new(Mutex::new(Vec::new()));
        let from = Fake {
            label: "legacy",
            running: Mutex::new(from_running.then_some(1337)),
            fail_start: fail_back,
            log: Arc::clone(&log),
            ..Fake::default()
        };
        let to = Fake {
            label: "core",
            fail_start: fail_to,
            log: Arc::clone(&log),
            ..Fake::default()
        };
        (from, to, log)
    }

    #[tokio::test]
    async fn nothing_serving_means_only_the_flag_moves() {
        let (from, to, log) = pair(false, false, false);
        assert_eq!(
            hand_over(&from, &to, Some(&config())).await,
            Ok(Handover::NotRunning)
        );
        assert!(log.lock().await.is_empty());
    }

    #[tokio::test]
    async fn the_outgoing_owner_stops_before_the_incoming_one_starts() {
        let (from, to, log) = pair(true, false, false);
        assert_eq!(
            hand_over(&from, &to, Some(&config())).await,
            Ok(Handover::Moved(1337))
        );
        assert_eq!(*log.lock().await, vec!["legacy stop", "core start"]);
        assert_eq!(*from.running.lock().await, None);
    }

    #[tokio::test]
    async fn a_failed_start_brings_the_previous_owner_back() {
        let (from, to, log) = pair(true, true, false);
        let error = hand_over(&from, &to, Some(&config())).await.unwrap_err();
        assert!(error.restored);
        assert_eq!(
            *log.lock().await,
            vec!["legacy stop", "core start", "legacy start"]
        );
        assert_eq!(*from.running.lock().await, Some(1337));
        assert!(error
            .to_string()
            .ends_with("The previous server was restored."));
    }

    #[tokio::test]
    async fn a_start_that_opens_a_listener_but_loses_its_reply_never_starts_another() {
        struct LostStart(Fake);
        #[async_trait]
        impl PublicApiOwner for LostStart {
            fn label(&self) -> &'static str { self.0.label() }
            async fn running_port(&self) -> Result<Option<u16>, String> { self.0.running_port().await }
            async fn start(&self, config: &StartServerConfig) -> Result<u16, String> {
                self.0.start(config).await?;
                Err("lost start response and rollback did not stop it".into())
            }
            async fn stop(&self) -> Result<(), String> { self.0.stop().await }
        }
        let (from, to, log) = pair(true, false, false);
        let error = hand_over(&from, &LostStart(to), Some(&config())).await.unwrap_err();
        assert!(!error.confirmed);
        assert!(!error.restored);
        assert_eq!(*log.lock().await, vec!["legacy stop", "core start"]);
        assert_eq!(*from.running.lock().await, None);
    }

    #[tokio::test]
    async fn when_both_sides_fail_the_server_is_reported_stopped() {
        let (from, to, _) = pair(true, true, true);
        let error = hand_over(&from, &to, Some(&config())).await.unwrap_err();
        assert!(!error.restored);
        assert!(error
            .message
            .contains("Restarting the legacy server failed too"));
        assert!(error
            .to_string()
            .ends_with("The Local API Server is now stopped."));
    }

    #[tokio::test]
    async fn an_unstoppable_or_unknown_server_is_left_as_it_was() {
        let (mut from, to, log) = pair(true, false, false);
        assert!(hand_over(&from, &to, None).await.unwrap_err().restored);
        from.fail_stop = true;
        let error = hand_over(&from, &to, Some(&config())).await.unwrap_err();
        assert!(error.restored);
        assert_eq!(*log.lock().await, vec!["legacy stop"]);
    }

    #[tokio::test]
    async fn a_lost_stop_response_is_rechecked_before_starting_the_new_listener() {
        let (mut from, to, log) = pair(true, false, false);
        from.lost_stop_response = true;
        assert_eq!(hand_over(&from, &to, Some(&config())).await, Ok(Handover::Moved(1337)));
        assert_eq!(*log.lock().await, vec!["legacy stop", "core start"]);
    }

    #[tokio::test]
    async fn unknown_stop_status_never_starts_a_second_listener() {
        let (mut from, to, log) = pair(true, false, false);
        from.lost_stop_response = true;
        // Status succeeds initially and fails only after stop via a test owner.
        struct UnknownAfterStop(Fake);
        #[async_trait]
        impl PublicApiOwner for UnknownAfterStop {
            fn label(&self) -> &'static str { self.0.label() }
            async fn running_port(&self) -> Result<Option<u16>, String> {
                if self.0.running.lock().await.is_none() { Err("status unreachable".into()) }
                else { self.0.running_port().await }
            }
            async fn start(&self, config: &StartServerConfig) -> Result<u16, String> { self.0.start(config).await }
            async fn stop(&self) -> Result<(), String> { self.0.stop().await }
        }
        let error = hand_over(&UnknownAfterStop(from), &to, Some(&config())).await.unwrap_err();
        assert!(!error.confirmed);
        assert_eq!(*log.lock().await, vec!["legacy stop"]);
    }

    struct Recorder {
        calls: Arc<Mutex<Vec<(String, String, Option<Value>)>>>,
        answer: Value,
        initially_running: bool,
    }

    #[async_trait]
    impl ControlCaller for Recorder {
        async fn call(
            &self,
            method: &str,
            path: &str,
            body: Option<Value>,
        ) -> Result<Value, CoreError> {
            let mut calls = self.calls.lock().await;
            calls.push((method.into(), path.into(), body));
            if path == "/server" && calls.len() == 1 && !self.initially_running {
                return Ok(json!({"running": false}));
            }
            Ok(self.answer.clone())
        }
    }

    struct FailedStart {
        calls: Arc<Mutex<Vec<String>>>,
        fail_path: &'static str,
        fail_code: &'static str,
        listener_open: bool,
    }

    #[async_trait]
    impl ControlCaller for FailedStart {
        async fn call(
            &self,
            method: &str,
            path: &str,
            _body: Option<Value>,
        ) -> Result<Value, CoreError> {
            let mut calls = self.calls.lock().await;
            calls.push(format!("{method} {path}"));
            if path == self.fail_path {
                return Err(CoreError::new(self.fail_code, "lost response", None));
            }
            if path == "/server" {
                return Ok(json!({"running": self.listener_open && calls.len() > 1, "port": 1337}));
            }
            Ok(json!({"port": 1337}))
        }
    }

    #[tokio::test]
    async fn failed_provider_handover_withdraws_sessions_without_starting_public_listener() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let owner = CoreOwner {
            caller: FailedStart {
                calls: Arc::clone(&calls),
                fail_path: "/cloud/providers/cloud",
                fail_code: "CORE_UNREACHABLE",
                listener_open: false,
            },
            external_sessions: vec![json!({"model_id": "local"})],
            external_generation: 7,
            providers: vec![("cloud".into(), json!({}))],
        };
        assert!(owner
            .start(&config())
            .await
            .unwrap_err()
            .contains("could not hand provider"));
        assert_eq!(
            *calls.lock().await,
            vec![
                "GET /server",
                "PUT /external-sessions/atomic-chat-app",
                "PUT /cloud/providers/cloud",
                "DELETE /external-sessions/atomic-chat-app",
            ]
        );
    }

    #[tokio::test]
    async fn lost_start_response_stops_a_listener_before_withdrawing_its_models() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let owner = CoreOwner {
            caller: FailedStart {
                calls: Arc::clone(&calls),
                fail_path: "/server/start",
                fail_code: "CORE_UNREACHABLE",
                listener_open: true,
            },
            external_sessions: Vec::new(),
            external_generation: 7,
            providers: Vec::new(),
        };
        assert_eq!(owner.start(&config()).await, Err("lost response".into()));
        assert_eq!(
            *calls.lock().await,
            vec![
                "GET /server",
                "PUT /external-sessions/atomic-chat-app",
                "POST /auth/chatgpt/reload",
                "POST /server/start",
                "GET /server",
                "POST /server/stop",
                "DELETE /external-sessions/atomic-chat-app",
            ]
        );
    }

    #[tokio::test]
    async fn concurrent_already_running_refusal_never_stops_the_other_listener() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let owner = CoreOwner {
            caller: FailedStart {
                calls: Arc::clone(&calls),
                fail_path: "/server/start",
                fail_code: "CORE_ALREADY_RUNNING",
                listener_open: true,
            },
            external_sessions: Vec::new(),
            external_generation: 7,
            providers: Vec::new(),
        };
        assert_eq!(owner.start(&config()).await, Err("lost response".into()));
        assert_eq!(
            *calls.lock().await,
            vec![
                "GET /server",
                "PUT /external-sessions/atomic-chat-app",
                "POST /auth/chatgpt/reload",
                "POST /server/start",
                "DELETE /external-sessions/atomic-chat-app",
            ]
        );
    }

    #[tokio::test]
    async fn already_running_core_server_is_never_reconfigured_or_stopped() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let owner = CoreOwner {
            caller: Recorder {
                calls: Arc::clone(&calls),
                answer: json!({"running": true, "port": 1337}),
                initially_running: true,
            },
            external_sessions: Vec::new(),
            external_generation: 1,
            providers: Vec::new(),
        };
        assert!(owner
            .start(&config())
            .await
            .unwrap_err()
            .contains("already running"));
        assert_eq!(calls.lock().await.len(), 1);
    }

    #[tokio::test]
    async fn the_core_receives_every_provider_before_it_serves_and_writes_the_state_file() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let owner = CoreOwner {
            caller: Recorder {
                calls: Arc::clone(&calls),
                answer: json!({"running": true, "port": 43121}),
                initially_running: false,
            },
            providers: vec![("my provider".into(), json!({"models": ["m"]}))],
            external_sessions: Vec::new(),
            external_generation: 1,
        };

        assert_eq!(owner.start(&config()).await, Ok(43121));
        assert_eq!(owner.running_port().await, Ok(Some(43121)));
        owner.stop().await.unwrap();

        let calls = calls.lock().await;
        assert_eq!(calls[0].1, "/server");
        assert_eq!(calls[1].1, "/external-sessions/atomic-chat-app");
        assert_eq!(calls[2].1, "/cloud/providers/my%20provider");
        assert_eq!(calls[3].1, "/auth/chatgpt/reload");
        assert_eq!(
            calls[4],
            (
                "POST".into(),
                "/server/start".into(),
                Some(json!({
                    "host": "127.0.0.1", "port": 1337, "prefix": "/v1", "api_key": "k",
                    "trusted_hosts": ["lan"], "proxy_timeout_secs": 600,
                    "state_file": true, "fallback_port": true
                }))
            )
        );
        assert_eq!(calls[6].1, "/server/stop");
        assert_eq!(calls[7].1, "/external-sessions/atomic-chat-app");
    }
}
