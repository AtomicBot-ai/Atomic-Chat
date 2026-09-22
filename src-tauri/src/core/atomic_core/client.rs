//! The app's HTTP client for the core's control API (`/atomic/v1/*`).
//!
//! Everything the app asks of a running core goes through here. The API is
//! loopback-only and every request carries the control token as a bearer
//! credential — the token is the whole of the authorization, so it is read from
//! the `0600` file the owner published and never leaves this process.
//!
//! Errors arrive as `{"error":{"code","message","details"}}` and are surfaced as
//! `CoreError` with the code intact, because the app (and the webview behind it)
//! branches on codes like `CORE_ALREADY_RUNNING` and `MODEL_NOT_FOUND`. A
//! failure that never reached the core — a refused connection, a timeout — is
//! reported as `CORE_UNREACHABLE` so callers can tell "the core said no" from
//! "there was no core to ask".

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Wire version this app speaks. A core announcing anything else is refused
/// rather than talked to: the control API is the only channel, and guessing
/// across an incompatible version would corrupt state on the other side.
/// The wire contract's version, matched exactly against the core's.
///
/// 2 since a session stopped having to be a process on this machine: `pid` became nullable, and an
/// app built against 1 cannot deserialize a container session — it would drop it silently instead
/// of failing. This check is what turns that into a refusal to attach.
pub const CONTROL_PROTOCOL_VERSION: u32 = 2;

pub const CONTROL_API_PREFIX: &str = "/atomic/v1";

/// §3.6: readiness is a health check answered within 15 s, not a model loaded.
pub const HEALTH_TIMEOUT: Duration = Duration::from_secs(15);

/// Ordinary control calls are bounded. Model loads deliberately are not: the
/// core owns their readiness timeout, which is at least 1800 seconds and may be
/// configured higher, so a shorter transport deadline would turn a healthy
/// load into an ambiguous failure and tempt the caller to repeat it.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(600);

/// An error the app can act on: either the core's own error envelope, or the
/// transport failing before it got there.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CoreError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

impl CoreError {
    pub fn new(code: &str, message: impl Into<String>, details: Option<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            details,
        }
    }

    /// The core was not reachable at all — no answer, or not one we could read.
    pub fn unreachable(message: impl Into<String>, details: impl Into<String>) -> Self {
        Self::new("CORE_UNREACHABLE", message, Some(details.into()))
    }

    pub fn is_unreachable(&self) -> bool {
        self.code == "CORE_UNREACHABLE"
    }
}

impl std::fmt::Display for CoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.details {
            Some(details) => write!(f, "{}: {} ({details})", self.code, self.message),
            None => write!(f, "{}: {}", self.code, self.message),
        }
    }
}

impl std::error::Error for CoreError {}

/// What `GET /atomic/v1/health` answers.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Health {
    pub ok: bool,
    #[serde(default)]
    pub owner_scope: Option<String>,
    pub pid: u32,
    pub version: String,
    pub instance_id: String,
    pub protocol: u32,
}

/// What `POST /atomic/v1/clients` answers: the registration, how often to
/// heartbeat, and a snapshot consistent with the cursor inside it.
#[derive(Debug, Clone, Deserialize)]
pub struct Registration {
    pub client: ClientRecord,
    pub heartbeat_interval_ms: u64,
    pub snapshot: Value,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct ClientRecord {
    pub id: String,
}

#[derive(Clone)]
pub struct ControlClient {
    base_url: String,
    token: String,
    http: reqwest::Client,
}

impl ControlClient {
    pub fn new(base_url: impl Into<String>, token: impl Into<String>) -> Result<Self, CoreError> {
        let http = reqwest::Client::builder()
            // The control API is on loopback. An HTTP_PROXY in the user's
            // environment — common on corporate machines — would otherwise send
            // these requests, token and all, to the proxy.
            .no_proxy()
            .build()
            .map_err(|e| {
                CoreError::unreachable("Could not create an HTTP client", e.to_string())
            })?;
        Ok(Self {
            base_url: base_url.into(),
            token: token.into(),
            http,
        })
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Absolute URL for a control path (`/health`, `/sessions`, …).
    pub fn url(&self, path: &str) -> String {
        format!("{}{CONTROL_API_PREFIX}{path}", self.base_url)
    }

    pub async fn health(&self) -> Result<Health, CoreError> {
        let value = self
            .request(reqwest::Method::GET, "/health", None, Some(HEALTH_TIMEOUT))
            .await?;
        serde_json::from_value(value).map_err(|e| {
            CoreError::unreachable("The core's health response was not readable", e.to_string())
        })
    }

    /// Confirm this is a core we can speak to before doing anything with it.
    ///
    /// Version *and* protocol are checked. The protocol is the wire contract, so
    /// a mismatch there is fatal; the version is checked because the app ships a
    /// specific core and a different one on the machine means the bundled binary
    /// and the running owner disagree about behaviour the wire cannot express.
    pub async fn handshake(&self, expected_version: Option<&str>) -> Result<Health, CoreError> {
        let health = self.health().await?;
        if expected_version.is_some() && health.owner_scope.as_deref() != Some("app") {
            return Err(CoreError::new(
                "CORE_PROTOCOL_MISMATCH",
                "This core does not belong to the Atomic Chat application.",
                Some(format!("scope {:?} at {}", health.owner_scope, self.base_url)),
            ));
        }
        if health.protocol != CONTROL_PROTOCOL_VERSION {
            return Err(CoreError::new(
                "CORE_PROTOCOL_MISMATCH",
                format!(
                    "This core speaks control protocol {}, and this app speaks {CONTROL_PROTOCOL_VERSION}.",
                    health.protocol
                ),
                Some(format!("core {} at {}", health.version, self.base_url)),
            ));
        }
        if let Some(expected) = expected_version {
            if health.version != expected {
                return Err(CoreError::new(
                    "CORE_VERSION_MISMATCH",
                    format!(
                        "A different Atomic Chat core is already running: {} (this app ships {expected}).",
                        health.version
                    ),
                    Some(format!(
                        "stop it before starting this app, or quit this app: pid {}",
                        health.pid
                    )),
                ));
            }
        }
        Ok(health)
    }

    pub async fn snapshot(&self) -> Result<Value, CoreError> {
        self.request(
            reqwest::Method::GET,
            "/snapshot",
            None,
            Some(HEALTH_TIMEOUT),
        )
        .await
    }

    pub async fn register(&self, name: &str, pid: u32) -> Result<Registration, CoreError> {
        let value = self
            .request(
                reqwest::Method::POST,
                "/clients",
                Some(serde_json::json!({ "name": name, "pid": pid })),
                Some(HEALTH_TIMEOUT),
            )
            .await?;
        serde_json::from_value(value).map_err(|e| {
            CoreError::unreachable(
                "The core's registration response was not readable",
                e.to_string(),
            )
        })
    }

    /// `false` when the core no longer knows this registration — it expired
    /// while we were away, and the caller must register again.
    pub async fn heartbeat(&self, client_id: &str) -> Result<bool, CoreError> {
        match self
            .request(
                reqwest::Method::POST,
                &format!("/clients/{client_id}/heartbeat"),
                Some(serde_json::json!({})),
                Some(HEALTH_TIMEOUT),
            )
            .await
        {
            Ok(_) => Ok(true),
            Err(e) if e.code == "CORE_NOT_RUNNING" => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Detach. The core and its models keep running — that is the point of the
    /// owner model, and it is what lets a CLI-loaded model survive the app.
    pub async fn unregister(&self, client_id: &str) -> Result<(), CoreError> {
        self.request(
            reqwest::Method::DELETE,
            &format!("/clients/{client_id}"),
            None,
            Some(HEALTH_TIMEOUT),
        )
        .await
        .map(|_| ())
    }

    /// The generic call behind the `atomic_core_call` command: any control
    /// route, with the token attached here rather than in the webview.
    pub async fn call(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, CoreError> {
        let method =
            reqwest::Method::from_bytes(method.to_uppercase().as_bytes()).map_err(|_| {
                CoreError::new(
                    "INVALID_ARGUMENT",
                    format!("Not an HTTP method: {method}"),
                    None,
                )
            })?;
        if !path.starts_with('/') {
            return Err(CoreError::new(
                "INVALID_ARGUMENT",
                format!("A control path must start with '/': {path}"),
                None,
            ));
        }
        let timeout = control_call_timeout(&method, path);
        self.request(method, path, body, timeout).await
    }

    /// Open the event stream at `cursor`. Returns the raw response so the relay
    /// can read frames as they arrive; no timeout, because silence on this
    /// stream is normal.
    pub async fn open_events(&self, cursor: Option<&str>) -> Result<reqwest::Response, CoreError> {
        let mut url = self.url("/events");
        if let Some(cursor) = cursor.filter(|c| !c.is_empty()) {
            url = format!("{url}?cursor={}", urlencoding_minimal(cursor));
        }
        let response = self
            .http
            .get(&url)
            .bearer_auth(&self.token)
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .send()
            .await
            .map_err(|e| {
                CoreError::unreachable("Could not open the core's event stream", e.to_string())
            })?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(error_from_body(status, &body));
        }
        Ok(response)
    }

    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
        timeout: Option<Duration>,
    ) -> Result<Value, CoreError> {
        let url = self.url(path);
        let mut request = self.http.request(method, &url).bearer_auth(&self.token);
        if let Some(timeout) = timeout {
            request = request.timeout(timeout);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|e| {
            CoreError::unreachable(
                "The Atomic Chat core did not answer.",
                format!("{url}: {e}"),
            )
        })?;
        let status = response.status();
        let text = response.text().await.map_err(|e| {
            CoreError::unreachable("Could not read the core's response", e.to_string())
        })?;
        if !status.is_success() {
            return Err(error_from_body(status, &text));
        }
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text)
            .map_err(|e| CoreError::unreachable("The core's response was not JSON", e.to_string()))
    }
}

/// Calls whose deadline is the core's own: a model load, an embedding batch and a backend install
/// can all legitimately outlast `CALL_TIMEOUT`. The image-model load answers only once `sd-server`
/// is ready; the core's own budget for that (600 s by default, `startupTimeoutSecs`) starts at the
/// spawn, after it has cancelled a running job, torn the old session down and checked the files,
/// so any client deadline of the same length would fire first and hide the core's own error.
fn control_call_timeout(method: &reqwest::Method, path: &str) -> Option<Duration> {
    if method == reqwest::Method::POST
        && ((path.starts_with("/models/") && (path.ends_with("/load") || path.ends_with("/embed")))
            || (path.starts_with("/backends/") && path.ends_with("/install"))
            || path == "/diffusion/model/load")
    {
        None
    } else {
        Some(CALL_TIMEOUT)
    }
}

/// Turn a non-2xx body into a `CoreError`, keeping the core's own code when it
/// sent one. A body that is not the error envelope (a proxy's HTML page, an
/// auth gate's plain text) still has to produce something a caller can branch
/// on, so it becomes an `HTTP_<status>`.
fn error_from_body(status: reqwest::StatusCode, body: &str) -> CoreError {
    #[derive(Deserialize)]
    struct Envelope {
        error: Inner,
    }
    #[derive(Deserialize)]
    struct Inner {
        code: String,
        message: String,
        details: Option<String>,
    }

    match serde_json::from_str::<Envelope>(body) {
        Ok(envelope) => CoreError {
            code: envelope.error.code,
            message: envelope.error.message,
            details: envelope.error.details,
        },
        Err(_) => CoreError::new(
            &format!("HTTP_{}", status.as_u16()),
            format!("The core answered {status}."),
            Some(body.chars().take(500).collect()),
        ),
    }
}

/// Percent-encode the few characters a cursor could contain that would change
/// the meaning of the query string. Cursors are `<instance>:<seq>`, so this is
/// a guard against a malformed one, not a general encoder.
fn urlencoding_minimal(value: &str) -> String {
    value
        .chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' | ':' => c.to_string(),
            other => other
                .to_string()
                .bytes()
                .map(|b| format!("%{b:02X}"))
                .collect::<String>(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::atomic_core::test_support::FakeCore;

    #[test]
    fn builds_control_urls_under_the_versioned_prefix() {
        let client = ControlClient::new("http://127.0.0.1:9", "t").unwrap();

        assert_eq!(client.url("/health"), "http://127.0.0.1:9/atomic/v1/health");
    }

    #[test]
    fn encodes_only_what_would_break_a_query_string() {
        assert_eq!(urlencoding_minimal("abc-1:42"), "abc-1:42");
        assert_eq!(urlencoding_minimal("a&b=c"), "a%26b%3Dc");
        assert_eq!(urlencoding_minimal("a b"), "a%20b");
    }

    #[test]
    fn keeps_the_cores_error_code_and_invents_one_when_the_body_is_not_ours() {
        let ours = error_from_body(
            reqwest::StatusCode::CONFLICT,
            r#"{"error":{"code":"CORE_ALREADY_RUNNING","message":"busy","details":"pid 7"}}"#,
        );
        assert_eq!(ours.code, "CORE_ALREADY_RUNNING");
        assert_eq!(ours.details.as_deref(), Some("pid 7"));

        let foreign = error_from_body(reqwest::StatusCode::BAD_GATEWAY, "<html>proxy</html>");
        assert_eq!(foreign.code, "HTTP_502");
        assert!(foreign.details.unwrap().contains("proxy"));
    }

    #[test]
    fn long_running_load_install_and_embed_delegate_their_deadline_to_the_core() {
        assert_eq!(
            control_call_timeout(&reqwest::Method::GET, "/sessions"),
            Some(CALL_TIMEOUT)
        );
        assert_eq!(
            control_call_timeout(&reqwest::Method::POST, "/models/llamacpp-upstream/a/b/load"),
            None
        );
        assert_eq!(
            control_call_timeout(
                &reqwest::Method::POST,
                "/backends/llamacpp-upstream/install"
            ),
            None
        );
        assert_eq!(
            control_call_timeout(
                &reqwest::Method::POST,
                "/models/llamacpp-upstream/sentence-transformer-mini/embed"
            ),
            None
        );
        assert_eq!(
            control_call_timeout(
                &reqwest::Method::POST,
                "/models/llamacpp-upstream/a/b/unload"
            ),
            Some(CALL_TIMEOUT)
        );
        assert_eq!(
            control_call_timeout(&reqwest::Method::POST, "/diffusion/model/load"),
            None
        );
        assert_eq!(
            control_call_timeout(&reqwest::Method::POST, "/diffusion/jobs"),
            Some(CALL_TIMEOUT)
        );
    }

    #[tokio::test]
    async fn a_refused_connection_is_unreachable_not_a_core_error() {
        // Port 1 on loopback has nothing listening on any machine we support.
        let client = ControlClient::new("http://127.0.0.1:1", "t").unwrap();

        let error = client.health().await.unwrap_err();

        assert!(error.is_unreachable(), "got {error}");
    }

    #[tokio::test]
    async fn every_request_carries_the_control_token() {
        let core = FakeCore::start().await;
        let client = core.client();

        client.health().await.unwrap();

        assert_eq!(
            core.last_authorization().as_deref(),
            Some(format!("Bearer {}", core.token()).as_str())
        );
    }

    #[tokio::test]
    async fn a_request_without_the_token_is_refused_by_the_core() {
        let core = FakeCore::start().await;
        let wrong = ControlClient::new(core.base_url(), "not-the-token").unwrap();

        let error = wrong.health().await.unwrap_err();

        assert_eq!(error.code, "UNAUTHORIZED");
    }

    #[tokio::test]
    async fn handshake_accepts_the_core_this_app_ships() {
        let core = FakeCore::start().await;

        let health = core.client().handshake(Some("9.9.9")).await.unwrap();

        assert_eq!(health.version, "9.9.9");
        assert_eq!(health.protocol, CONTROL_PROTOCOL_VERSION);
    }

    #[tokio::test]
    async fn handshake_refuses_another_version_and_names_both() {
        let core = FakeCore::start().await;

        let error = core.client().handshake(Some("0.2.0")).await.unwrap_err();

        assert_eq!(error.code, "CORE_VERSION_MISMATCH");
        assert!(error.message.contains("9.9.9"), "{}", error.message);
        assert!(error.message.contains("0.2.0"), "{}", error.message);
    }

    #[tokio::test]
    async fn handshake_refuses_a_protocol_it_does_not_speak() {
        let core = FakeCore::start().await;
        core.set_protocol(CONTROL_PROTOCOL_VERSION + 1);

        let error = core.client().handshake(None).await.unwrap_err();

        assert_eq!(error.code, "CORE_PROTOCOL_MISMATCH");
    }

    #[tokio::test]
    async fn handshake_refuses_a_core_older_than_this_app() {
        // The direction that matters in practice: a released core still speaking 1 would hand this
        // app a session shape it cannot read, and dropping it silently is worse than not attaching.
        let core = FakeCore::start().await;
        core.set_protocol(1);

        let error = core.client().handshake(None).await.unwrap_err();

        assert_eq!(error.code, "CORE_PROTOCOL_MISMATCH");
        assert!(error.message.contains("protocol 1"), "{}", error.message);
        assert!(
            error.message.contains(&CONTROL_PROTOCOL_VERSION.to_string()),
            "{}",
            error.message
        );
    }

    #[tokio::test]
    async fn registers_heartbeats_and_detaches() {
        let core = FakeCore::start().await;
        let client = core.client();

        let registration = client.register("atomic-chat-app", 42).await.unwrap();
        assert!(registration.heartbeat_interval_ms > 0);
        assert!(registration.snapshot.get("cursor").is_some());

        assert!(client.heartbeat(&registration.client.id).await.unwrap());
        client.unregister(&registration.client.id).await.unwrap();

        assert!(
            !client.heartbeat(&registration.client.id).await.unwrap(),
            "a registration the core has forgotten must report expiry, not an error"
        );
    }

    #[tokio::test]
    async fn a_generic_call_reaches_an_arbitrary_control_route() {
        let core = FakeCore::start().await;

        let sessions = core.client().call("GET", "/sessions", None).await.unwrap();

        assert!(sessions.get("sessions").unwrap().is_array());
    }

    #[tokio::test]
    async fn a_generic_call_refuses_a_path_that_is_not_a_control_path() {
        let core = FakeCore::start().await;

        let error = core
            .client()
            .call("GET", "atomic/v1/sessions", None)
            .await
            .unwrap_err();

        assert_eq!(error.code, "INVALID_ARGUMENT");
    }
}
