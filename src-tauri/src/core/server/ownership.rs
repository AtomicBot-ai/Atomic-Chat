//! The public API's configuration and its owner (PLAN.md §4, stages 4e and 6).
//!
//! `start_server`, `stop_server` and `get_server_status` keep their names and
//! payloads; the webview does not know which process answers. On desktop the
//! core serves (`CoreOwner`); on mobile, where no core runs, the app's own proxy
//! does. Both sit behind `PublicApiOwner`.
//!
//! The core writes `<data>/local-api-server.json` while it serves (`state_file:
//! true`), so the CLI's `server status` reads the same file it always did. The
//! control API is never touched by a public-server stop.

use std::sync::Mutex as StdMutex;

use async_trait::async_trait;
use serde_json::{json, Value};

#[cfg(desktop)]
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

/// The configuration of the last successful `start_server`, so a core that restarted can bring the
/// server back exactly as the user configured it.
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
    /// The port it serves on, or `None` when it is not serving.
    async fn running_port(&self) -> Result<Option<u16>, String>;
    async fn start(&self, config: &StartServerConfig) -> Result<u16, String>;
    async fn stop(&self) -> Result<(), String>;
}

/// One control API call; the core owner does not care how it is carried.
#[cfg(desktop)]
#[async_trait]
pub trait ControlCaller: Send + Sync {
    async fn call(&self, method: &str, path: &str, body: Option<Value>)
        -> Result<Value, CoreError>;
}

/// The core as the server owner.
#[cfg(desktop)]
pub struct CoreOwner<C: ControlCaller> {
    pub caller: C,
    /// Provider registrations to hand the core before it starts serving, so a restarted core
    /// serves every cloud model the user registered: `(provider, control API body)`.
    pub providers: Vec<(String, Value)>,
}

/// The `/server/start` body for a configuration. The core writes the app's
/// state file while it owns the server, and falls back to a free port the way
/// the app's proxy did.
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

#[cfg(desktop)]
fn segment(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}

#[cfg(desktop)]
#[async_trait]
impl<C: ControlCaller> PublicApiOwner for CoreOwner<C> {
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
        // A listener that was already running was not started by this call; a lost /server/start
        // response is rolled back below only if it was observed stopped first.
        if self.running_port().await?.is_some() {
            return Err("the core public server is already running".into());
        }
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
            server_start_attempted = true;
            let state = match self
                .caller
                .call("POST", "/server/start", Some(core_start_body(config)))
                .await
            {
                Ok(state) => state,
                Err(error) => {
                    // A semantic refusal proves this call did not open a listener. In particular,
                    // AlreadyRunning belongs to somebody else; rollback must never stop it.
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
            // A lost response to the mutating start is ambiguous: it may have opened the listener.
            match self.running_port().await {
                Ok(Some(_)) => {
                    self.caller.call("POST", "/server/stop", None).await.map_err(|e| {
                        format!("{original}; could not roll back the core server: {}", e.message)
                    })?;
                }
                Ok(None) => {}
                Err(error) => return Err(format!("{original}; core server status is unknown: {error}")),
            }
        }
        Err(original)
    }

    async fn stop(&self) -> Result<(), String> {
        if let Err(error) = self.caller.call("POST", "/server/stop", None).await {
            if !error.is_unreachable() {
                return Err(error.message);
            }
            match self.running_port().await {
                Ok(None) => {}
                Ok(Some(_)) => return Err(error.message),
                Err(status) => return Err(format!("{}; server status is unknown: {status}", error.message)),
            }
        }
        Ok(())
    }
}

#[cfg(all(test, desktop))]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::sync::Mutex;

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
    async fn a_provider_the_core_refuses_never_starts_the_public_listener() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let owner = CoreOwner {
            caller: FailedStart {
                calls: Arc::clone(&calls),
                fail_path: "/cloud/providers/cloud",
                fail_code: "CORE_UNREACHABLE",
                listener_open: false,
            },
            providers: vec![("cloud".into(), json!({}))],
        };
        assert!(owner.start(&config()).await.unwrap_err().contains("could not hand provider"));
        assert_eq!(*calls.lock().await, vec!["GET /server", "PUT /cloud/providers/cloud"]);
    }

    #[tokio::test]
    async fn a_lost_start_response_stops_the_listener_it_may_have_opened() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let owner = CoreOwner {
            caller: FailedStart {
                calls: Arc::clone(&calls),
                fail_path: "/server/start",
                fail_code: "CORE_UNREACHABLE",
                listener_open: true,
            },
            providers: Vec::new(),
        };
        assert_eq!(owner.start(&config()).await, Err("lost response".into()));
        assert_eq!(
            *calls.lock().await,
            vec!["GET /server", "POST /server/start", "GET /server", "POST /server/stop"]
        );
    }

    #[tokio::test]
    async fn an_already_running_refusal_never_stops_the_other_listener() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let owner = CoreOwner {
            caller: FailedStart {
                calls: Arc::clone(&calls),
                fail_path: "/server/start",
                fail_code: "CORE_ALREADY_RUNNING",
                listener_open: true,
            },
            providers: Vec::new(),
        };
        assert_eq!(owner.start(&config()).await, Err("lost response".into()));
        assert_eq!(*calls.lock().await, vec!["GET /server", "POST /server/start"]);
    }

    #[tokio::test]
    async fn an_already_running_core_server_is_never_reconfigured_or_stopped() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let owner = CoreOwner {
            caller: Recorder {
                calls: Arc::clone(&calls),
                answer: json!({"running": true, "port": 1337}),
                initially_running: true,
            },
            providers: Vec::new(),
        };
        assert!(owner.start(&config()).await.unwrap_err().contains("already running"));
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
        };

        assert_eq!(owner.start(&config()).await, Ok(43121));
        assert_eq!(owner.running_port().await, Ok(Some(43121)));
        owner.stop().await.unwrap();

        let calls = calls.lock().await;
        assert_eq!(calls[0].1, "/server");
        assert_eq!(calls[1].1, "/cloud/providers/my%20provider");
        assert_eq!(
            calls[2],
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
        assert_eq!(calls[4].1, "/server/stop");
    }
}
