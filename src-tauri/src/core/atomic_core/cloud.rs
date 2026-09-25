//! Cloud providers and the ChatGPT subscription, as the app hands them to the
//! core (PLAN.md §4, stages 4c and 6).
//!
//! The core serves the public API on desktop, so a provider registration is the
//! core's registration: a failed mirror is returned to the webview. The ChatGPT
//! session has exactly one writer (PLAN.md §2 decision 11) — the core — and every
//! `chatgpt_*` command goes there.

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime};

use super::client::CoreError;
use super::commands::AtomicCoreClient;
use crate::core::auth::state::ChatGptStatus;
use crate::core::server::chatgpt_route::SubscriptionModel;
use crate::core::server::remote_provider_commands::RegisterProviderRequest;

fn client<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::State<'_, AtomicCoreClient>> {
    app.try_state::<AtomicCoreClient>()
        .filter(|client| client.is_enabled())
}

/// A provider id as one path segment of the control API.
fn segment(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}

fn message(error: CoreError) -> String {
    error.message
}

/// The control API body for a registration. `api_key: null` clears a stored
/// key, which is what an app registration without a key means.
pub fn provider_body(request: &RegisterProviderRequest) -> Value {
    json!({
        "api_key": request.api_key,
        "base_url": request.base_url,
        "custom_headers": request
            .custom_headers
            .iter()
            .map(|h| json!({"header": h.header, "value": h.value}))
            .collect::<Vec<_>>(),
        "models": request.models,
    })
}

async fn apply<R: Runtime>(
    app: &AppHandle<R>,
    method: &str,
    path: String,
    body: Option<Value>,
) -> Result<(), String> {
    let Some(client) = client(app) else {
        return Err("The Atomic Chat core serves the API but is not running.".to_string());
    };
    client.call(method, &path, body).await.map(|_| ()).map_err(message)
}

pub async fn mirror_provider<R: Runtime>(
    app: &AppHandle<R>,
    request: &RegisterProviderRequest,
) -> Result<(), String> {
    apply(
        app,
        "PUT",
        format!("/cloud/providers/{}", segment(&request.provider)),
        Some(provider_body(request)),
    )
    .await
}

pub async fn unmirror_provider<R: Runtime>(app: &AppHandle<R>, provider: &str) -> Result<(), String> {
    apply(
        app,
        "DELETE",
        format!("/cloud/providers/{}", segment(provider)),
        None,
    )
    .await
}

/// The core's answer to a ChatGPT command.
async fn chatgpt_call<R: Runtime>(app: &AppHandle<R>, method: &str, path: &str) -> Result<Value, String> {
    let Some(client) = client(app) else {
        return Err("The Atomic Chat core owns the ChatGPT session but is not running.".to_string());
    };
    client.call(method, path, None).await.map_err(message)
}

fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|e| format!("unexpected answer from the core: {e}"))
}

pub async fn chatgpt_status<R: Runtime>(app: &AppHandle<R>) -> Result<ChatGptStatus, String> {
    chatgpt_call(app, "GET", "/auth/chatgpt").await.and_then(decode)
}

pub async fn chatgpt_logout<R: Runtime>(app: &AppHandle<R>) -> Result<ChatGptStatus, String> {
    chatgpt_call(app, "POST", "/auth/chatgpt/logout").await.and_then(decode)
}

pub async fn chatgpt_cancel_login<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    chatgpt_call(app, "POST", "/auth/chatgpt/login/cancel").await.map(|_| ())
}

pub async fn chatgpt_models<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<SubscriptionModel>, String> {
    chatgpt_call(app, "GET", "/auth/chatgpt/models")
        .await
        .and_then(|value| decode(value.get("models").cloned().unwrap_or(Value::Null)))
}

/// Sign in through the core: it binds the callback listener and names the URL,
/// the app opens the browser (a headless core cannot), then waits.
pub async fn chatgpt_login<R: Runtime>(
    app: &AppHandle<R>,
    open: impl FnOnce(&str) -> Result<(), String>,
) -> Result<ChatGptStatus, String> {
    let started = chatgpt_call(app, "POST", "/auth/chatgpt/login").await?;
    let Some(url) = started.get("authorize_url").and_then(Value::as_str) else {
        return Err("the core did not say where to sign in".to_string());
    };
    if let Err(error) = open(url) {
        let _ = chatgpt_call(app, "POST", "/auth/chatgpt/login/cancel").await;
        return Err(format!("cannot open the browser for sign-in: {error}"));
    }
    chatgpt_call(app, "POST", "/auth/chatgpt/login/wait").await.and_then(decode)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::server::remote_provider_commands::ProviderCustomHeader;

    #[test]
    fn a_provider_id_is_one_path_segment() {
        assert_eq!(segment("openai"), "openai");
        assert_eq!(segment("my provider/x"), "my%20provider%2Fx");
    }

    #[test]
    fn a_registration_without_a_key_clears_the_stored_one() {
        let body = provider_body(&RegisterProviderRequest {
            provider: "ollama".into(),
            api_key: None,
            base_url: Some("http://localhost:11434/v1".into()),
            custom_headers: vec![ProviderCustomHeader {
                header: "X-Org".into(),
                value: "acme".into(),
            }],
            models: vec!["llama3".into()],
        });
        assert_eq!(
            body,
            json!({
                "api_key": null,
                "base_url": "http://localhost:11434/v1",
                "custom_headers": [{"header": "X-Org", "value": "acme"}],
                "models": ["llama3"],
            })
        );
    }
}
