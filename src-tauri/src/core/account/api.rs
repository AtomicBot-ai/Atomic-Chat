//! Thin client for the account API (`atomic-chat-backend` README, "Accounts
//! API"). It knows the wire format and nothing about where tokens are kept.

use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri_plugin_http::reqwest::{self, header, Method, StatusCode};
use url::Url;

use super::client_info::ClientInfo;

pub const DEFAULT_BASE_URL: &str = "https://api.atomic.chat";

/// Points the app at another account API, e.g. a local backend on
/// `http://127.0.0.1:8193`.
pub const BASE_URL_ENV: &str = "ATOMIC_ACCOUNT_API_URL";

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// What a failed account call tells the UI. `code` is the backend's stable
/// `error` field, or one of the client-side codes below.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountError {
    pub code: String,
    pub message: String,
    pub attempts_left: Option<u32>,
    pub retry_after: Option<u64>,
}

/// Client-side codes. Backend codes pass through unchanged.
pub mod codes {
    pub const NETWORK: &str = "network";
    pub const NOT_SIGNED_IN: &str = "not_signed_in";
    pub const CANCELLED: &str = "cancelled";
    pub const TIMEOUT: &str = "timeout";
    pub const UNEXPECTED: &str = "unexpected";
    pub const CONFIG: &str = "config";
    pub const INVALID_REQUEST: &str = "invalid_request";
    pub const SERVER_ERROR: &str = "server_error";
    /// The backend's answer to a refresh with a dead session.
    pub const INVALID_GRANT: &str = "invalid_grant";
    pub const INVALID_TOKEN: &str = "invalid_token";
}

impl AccountError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            attempts_left: None,
            retry_after: None,
        }
    }

    pub fn is(&self, code: &str) -> bool {
        self.code == code
    }
}

impl std::fmt::Display for AccountError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AccountError {}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct TokenUser {
    pub id: String,
    pub email: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub expires_in: i64,
    pub refresh_token: String,
    pub session_id: String,
    pub user: TokenUser,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct EmailChallenge {
    pub challenge_id: String,
    pub expires_in: u64,
    pub resend_in: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct IdentityInfo {
    pub provider: String,
    pub email: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct MeResponse {
    pub id: String,
    pub email: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
    pub created_at: String,
    pub identities: Vec<IdentityInfo>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all(serialize = "camelCase"))]
pub struct SessionInfo {
    pub id: String,
    pub client_type: String,
    pub device_name: Option<String>,
    pub platform: Option<String>,
    pub app_version: Option<String>,
    pub auth_method: String,
    pub created_at: String,
    pub last_used_at: String,
    pub expires_at: String,
    pub current: bool,
}

#[derive(Deserialize)]
struct SessionsResponse {
    sessions: Vec<SessionInfo>,
}

#[derive(Deserialize)]
struct ProvidersResponse {
    providers: Vec<String>,
}

#[derive(Deserialize)]
struct ErrorBody {
    error: Option<String>,
    detail: Option<serde_json::Value>,
    attempts_left: Option<u32>,
}

/// The configured API origin: the env override when set, else production.
/// Plain `http` is accepted for loopback only, so an override can never send
/// tokens over the network unencrypted.
pub fn base_url_from_env() -> Result<Url, AccountError> {
    match std::env::var(BASE_URL_ENV) {
        Ok(raw) if !raw.trim().is_empty() => parse_base_url(raw.trim()),
        _ => Ok(Url::parse(DEFAULT_BASE_URL).expect("default account API URL is valid")),
    }
}

pub fn parse_base_url(raw: &str) -> Result<Url, AccountError> {
    let url = Url::parse(raw.trim_end_matches('/')).map_err(|e| {
        AccountError::new(codes::CONFIG, format!("{BASE_URL_ENV} is not a URL: {e}"))
    })?;
    let loopback = matches!(
        url.host_str(),
        Some("127.0.0.1") | Some("localhost") | Some("[::1]")
    );
    match url.scheme() {
        "https" => Ok(url),
        "http" if loopback => Ok(url),
        _ => Err(AccountError::new(
            codes::CONFIG,
            format!("{BASE_URL_ENV} must be https, or http on a loopback address"),
        )),
    }
}

/// Turn a non-success response into an `AccountError`. Pure for the tests.
pub fn error_from_response(
    status: StatusCode,
    retry_after: Option<&str>,
    body: &str,
) -> AccountError {
    let parsed = serde_json::from_str::<ErrorBody>(body).ok();
    let code = parsed
        .as_ref()
        .and_then(|b| b.error.clone())
        .unwrap_or_else(|| {
            match status {
                StatusCode::UNPROCESSABLE_ENTITY | StatusCode::BAD_REQUEST => {
                    codes::INVALID_REQUEST
                }
                StatusCode::UNAUTHORIZED => codes::INVALID_TOKEN,
                StatusCode::TOO_MANY_REQUESTS => "rate_limited",
                s if s.is_server_error() => codes::SERVER_ERROR,
                _ => codes::UNEXPECTED,
            }
            .to_string()
        });
    let message = parsed
        .as_ref()
        .and_then(|b| match &b.detail {
            Some(serde_json::Value::String(s)) => Some(s.clone()),
            _ => None,
        })
        .unwrap_or_else(|| format!("account API answered {status}"));
    AccountError {
        code,
        message,
        attempts_left: parsed.and_then(|b| b.attempts_left),
        retry_after: retry_after.and_then(|v| v.trim().parse::<u64>().ok()),
    }
}

fn network_error(err: reqwest::Error) -> AccountError {
    AccountError::new(
        codes::NETWORK,
        format!("cannot reach the account service: {err}"),
    )
}

#[derive(Clone)]
pub struct AccountApi {
    base: Url,
    http: reqwest::Client,
}

impl AccountApi {
    pub fn new(base: Url) -> Result<Self, AccountError> {
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| {
                AccountError::new(codes::UNEXPECTED, format!("cannot build HTTP client: {e}"))
            })?;
        Ok(Self { base, http })
    }

    pub fn base(&self) -> &Url {
        &self.base
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base.as_str().trim_end_matches('/'))
    }

    pub(in crate::core::account) async fn call(
        &self,
        method: Method,
        path: &str,
        bearer: Option<&str>,
        body: Option<serde_json::Value>,
    ) -> Result<String, AccountError> {
        self.call_timed(method, path, bearer, body, REQUEST_TIMEOUT)
            .await
    }

    /// `call` with its own deadline, for long-polls that wait on the server.
    pub(in crate::core::account) async fn call_timed(
        &self,
        method: Method,
        path: &str,
        bearer: Option<&str>,
        body: Option<serde_json::Value>,
        timeout: Duration,
    ) -> Result<String, AccountError> {
        let mut request = self
            .http
            .request(method, self.url(path))
            .timeout(timeout)
            .header(header::ACCEPT, "application/json");
        if let Some(token) = bearer {
            request = request.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        if let Some(body) = body {
            let bytes = serde_json::to_vec(&body).map_err(|e| {
                AccountError::new(codes::UNEXPECTED, format!("cannot encode request: {e}"))
            })?;
            request = request
                .header(header::CONTENT_TYPE, "application/json")
                .body(bytes);
        }

        let response = request.send().await.map_err(network_error)?;
        let status = response.status();
        let retry_after = response
            .headers()
            .get(header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let text = response.text().await.map_err(network_error)?;
        if status.is_success() {
            Ok(text)
        } else {
            Err(error_from_response(status, retry_after.as_deref(), &text))
        }
    }

    pub(in crate::core::account) async fn call_json<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        bearer: Option<&str>,
        body: Option<serde_json::Value>,
    ) -> Result<T, AccountError> {
        self.call_json_timed(method, path, bearer, body, REQUEST_TIMEOUT)
            .await
    }

    pub(in crate::core::account) async fn call_json_timed<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        bearer: Option<&str>,
        body: Option<serde_json::Value>,
        timeout: Duration,
    ) -> Result<T, AccountError> {
        let text = self.call_timed(method, path, bearer, body, timeout).await?;
        serde_json::from_str(&text).map_err(|e| {
            AccountError::new(
                codes::UNEXPECTED,
                format!("unexpected answer from {path}: {e}"),
            )
        })
    }

    pub async fn providers(&self) -> Result<Vec<String>, AccountError> {
        let body: ProvidersResponse = self
            .call_json(Method::GET, "/v1/auth/providers", None, None)
            .await?;
        Ok(body.providers)
    }

    pub async fn email_start(
        &self,
        email: &str,
        client: &ClientInfo,
    ) -> Result<EmailChallenge, AccountError> {
        self.call_json(
            Method::POST,
            "/v1/auth/email/start",
            None,
            Some(json!({ "email": email, "client": client })),
        )
        .await
    }

    pub async fn email_verify(
        &self,
        challenge_id: &str,
        code: &str,
        client: &ClientInfo,
    ) -> Result<TokenResponse, AccountError> {
        self.call_json(
            Method::POST,
            "/v1/auth/email/verify",
            None,
            Some(json!({ "challenge_id": challenge_id, "code": code, "client": client })),
        )
        .await
    }

    /// Where the browser goes for a provider sign-in.
    pub fn authorize_url(
        &self,
        provider: &str,
        redirect_uri: &str,
        code_challenge: &str,
        state: &str,
    ) -> String {
        let mut url = Url::parse(&self.url(&format!("/v1/auth/oauth/{provider}/authorize")))
            .expect("authorize URL is built from a valid base");
        url.query_pairs_mut()
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("code_challenge", code_challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", state);
        url.to_string()
    }

    pub async fn exchange_code(
        &self,
        code: &str,
        code_verifier: &str,
        redirect_uri: &str,
        client: &ClientInfo,
    ) -> Result<TokenResponse, AccountError> {
        self.call_json(
            Method::POST,
            "/v1/auth/token",
            None,
            Some(json!({
                "grant_type": "authorization_code",
                "code": code,
                "code_verifier": code_verifier,
                "redirect_uri": redirect_uri,
                "client": client,
            })),
        )
        .await
    }

    pub async fn refresh(&self, refresh_token: &str) -> Result<TokenResponse, AccountError> {
        self.call_json(
            Method::POST,
            "/v1/auth/token",
            None,
            Some(json!({ "grant_type": "refresh_token", "refresh_token": refresh_token })),
        )
        .await
    }

    pub async fn logout(&self, access_token: &str) -> Result<(), AccountError> {
        self.call(Method::POST, "/v1/auth/logout", Some(access_token), None)
            .await
            .map(|_| ())
    }

    pub async fn me(&self, access_token: &str) -> Result<MeResponse, AccountError> {
        self.call_json(Method::GET, "/v1/me", Some(access_token), None)
            .await
    }

    pub async fn update_me(
        &self,
        access_token: &str,
        display_name: &str,
    ) -> Result<MeResponse, AccountError> {
        self.call_json(
            Method::PATCH,
            "/v1/me",
            Some(access_token),
            Some(json!({ "display_name": display_name })),
        )
        .await
    }

    pub async fn delete_me(&self, access_token: &str) -> Result<(), AccountError> {
        self.call(Method::DELETE, "/v1/me", Some(access_token), None)
            .await
            .map(|_| ())
    }

    pub async fn sessions(&self, access_token: &str) -> Result<Vec<SessionInfo>, AccountError> {
        let body: SessionsResponse = self
            .call_json(Method::GET, "/v1/me/sessions", Some(access_token), None)
            .await?;
        Ok(body.sessions)
    }

    pub async fn revoke_session(
        &self,
        access_token: &str,
        session_id: &str,
    ) -> Result<(), AccountError> {
        // A session id is a UUID; anything else would be a path injection.
        if session_id.is_empty()
            || !session_id
                .bytes()
                .all(|b| b.is_ascii_hexdigit() || b == b'-')
        {
            return Err(AccountError::new(
                codes::INVALID_REQUEST,
                "not a session id",
            ));
        }
        self.call(
            Method::DELETE,
            &format!("/v1/me/sessions/{session_id}"),
            Some(access_token),
            None,
        )
        .await
        .map(|_| ())
    }
}
