//! Cloud providers and the ChatGPT subscription, as the app hands them to the
//! core (PLAN.md §4, stage 4c).
//!
//! Two different rules, on purpose:
//!
//! *Provider registrations are mirrored whenever a core is attached*, whoever
//! serves the public API. That is the "import before handover" of the plan: by
//! the time the core takes `:1337` it already knows every provider and key the
//! user entered, so the switch does not lose cloud models. While the app's own
//! server is the owner a failed mirror is only logged — the legacy server does
//! not need it. Once the core owns the server the mirror *is* the registration,
//! and a failure is returned to the webview.
//!
//! *The ChatGPT session has exactly one writer* (PLAN.md §2 decision 11). The
//! token file is shared, and a refresh rotates the refresh token, so two
//! processes refreshing independently would sign the user out. While the core
//! owns the server every `chatgpt_*` command goes to the core and the app's own
//! auth state is left untouched; the app refreshes only while it owns the server.

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime};

use super::client::CoreError;
use super::commands::AtomicCoreClient;
use crate::core::app::commands::get_app_configurations;
use crate::core::auth::state::ChatGptStatus;
use crate::core::server::chatgpt_route::SubscriptionModel;
use crate::core::server::remote_provider_commands::RegisterProviderRequest;

/// Whether the core serves the public API, per the persisted ownership flags.
pub fn core_owns_server<R: Runtime>(app: &AppHandle<R>) -> bool {
    get_app_configurations(app.clone()).atomic_core.core_serves()
}

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
    what: &str,
    method: &str,
    path: String,
    body: Option<Value>,
) -> Result<(), String> {
    let owned = core_owns_server(app);
    let Some(client) = client(app) else {
        return if owned {
            Err("The Atomic Chat core serves the API but is not attached.".to_string())
        } else {
            Ok(())
        };
    };
    match client.call(method, &path, body).await {
        Ok(_) => Ok(()),
        Err(error) if owned => Err(message(error)),
        Err(error) => {
            log::warn!("[atomic-core] could not mirror {what} to the core: {}", error.message);
            Ok(())
        }
    }
}

pub async fn mirror_provider<R: Runtime>(
    app: &AppHandle<R>,
    request: &RegisterProviderRequest,
) -> Result<(), String> {
    apply(
        app,
        "a provider registration",
        "PUT",
        format!("/cloud/providers/{}", segment(&request.provider)),
        Some(provider_body(request)),
    )
    .await
}

pub async fn unmirror_provider<R: Runtime>(app: &AppHandle<R>, provider: &str) -> Result<(), String> {
    apply(
        app,
        "a provider removal",
        "DELETE",
        format!("/cloud/providers/{}", segment(provider)),
        None,
    )
    .await
}

/// The core's answer to a ChatGPT command, or `None` when the app still owns
/// the session and should answer itself.
async fn chatgpt_call<R: Runtime>(
    app: &AppHandle<R>,
    method: &str,
    path: &str,
) -> Option<Result<Value, String>> {
    if !core_owns_server(app) {
        return None;
    }
    let Some(client) = client(app) else {
        return Some(Err(
            "The Atomic Chat core owns the ChatGPT session but is not attached.".to_string(),
        ));
    };
    Some(client.call(method, path, None).await.map_err(message))
}

fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|e| format!("unexpected answer from the core: {e}"))
}

pub async fn chatgpt_status<R: Runtime>(app: &AppHandle<R>) -> Option<Result<ChatGptStatus, String>> {
    Some(chatgpt_call(app, "GET", "/auth/chatgpt").await?.and_then(decode))
}

pub async fn chatgpt_logout<R: Runtime>(app: &AppHandle<R>) -> Option<Result<ChatGptStatus, String>> {
    Some(chatgpt_call(app, "POST", "/auth/chatgpt/logout").await?.and_then(decode))
}

pub async fn chatgpt_cancel_login<R: Runtime>(app: &AppHandle<R>) -> Option<Result<(), String>> {
    Some(chatgpt_call(app, "POST", "/auth/chatgpt/login/cancel").await?.map(|_| ()))
}

pub async fn chatgpt_models<R: Runtime>(
    app: &AppHandle<R>,
) -> Option<Result<Vec<SubscriptionModel>, String>> {
    Some(
        chatgpt_call(app, "GET", "/auth/chatgpt/models")
            .await?
            .and_then(|value| decode(value.get("models").cloned().unwrap_or(Value::Null))),
    )
}

/// Sign in through the core: it binds the callback listener and names the URL,
/// the app opens the browser (a headless core cannot), then waits.
pub async fn chatgpt_login<R: Runtime>(
    app: &AppHandle<R>,
    open: impl FnOnce(&str) -> Result<(), String>,
) -> Option<Result<ChatGptStatus, String>> {
    let started = match chatgpt_call(app, "POST", "/auth/chatgpt/login").await? {
        Ok(value) => value,
        Err(error) => return Some(Err(error)),
    };
    let Some(url) = started.get("authorize_url").and_then(Value::as_str) else {
        return Some(Err("the core did not say where to sign in".to_string()));
    };
    if let Err(error) = open(url) {
        let _ = chatgpt_call(app, "POST", "/auth/chatgpt/login/cancel").await;
        return Some(Err(format!("cannot open the browser for sign-in: {error}")));
    }
    Some(
        chatgpt_call(app, "POST", "/auth/chatgpt/login/wait")
            .await?
            .and_then(decode),
    )
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
