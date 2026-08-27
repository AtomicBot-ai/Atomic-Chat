//! The `/chat/completions` branch that serves a ChatGPT subscription.
//!
//! Kept out of the generic forwarder on purpose. That path
//! (`proxy.rs`, roughly 800 lines) carries the auto-increase-ctx retry, the
//! `/messages` fallback, telemetry and the SSE relay; splicing a body rewrite
//! *and* a response rewrite into it would put four independent failure surfaces
//! in the way of every other provider. This mirrors `handle_responses_request`
//! instead: parse, decide, own the whole response.
//!
//! Requests are built from scratch rather than by forwarding the client's
//! headers the way the generic path does — this endpoint is particular about
//! what it receives, and the bearer token must never be the client's.

use std::time::Duration;

use futures_util::StreamExt;
use hyper::body::Bytes;
use hyper::{Body, Response, StatusCode};
use reqwest::Client;
use serde_json::Value;

use crate::core::auth::state::ChatGptAuthState;
use crate::core::server::chat_to_responses_shim::ChatChunkStreamConverter;
use crate::core::server::sse::{SseData, SseLine, SseLineReader};

/// The provider id the frontend registers this connection under.
pub const CHATGPT_PROVIDER: &str = "chatgpt";

/// Base of the subscription API. No trailing slash — `proxy.rs` joins paths
/// without trimming one.
pub const CHATGPT_BASE_URL: &str = "https://chatgpt.com/backend-api/codex";

/// Identifies the caller to the backend. Kept as a constant so there is exactly
/// one place to change if the contract moves.
const ORIGINATOR: &str = "atomic_chat";

/// Sent alongside `originator`. Both identify *this* client — we present
/// ourselves, not another product.
const USER_AGENT: &str = "atomic-chat/1";

const REQUEST_TIMEOUT: Duration = Duration::from_secs(600);

/// `/codex/models` hides any slug whose `minimal_client_version` exceeds the
/// version we claim, so this is what decides which models the account is shown.
const CLIENT_VERSION: &str = "0.156.0";

/// One model the subscription offers.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SubscriptionModel {
    pub id: String,
    pub display_name: String,
    pub context_length: Option<u64>,
    pub vision: bool,
    pub reasoning_efforts: Vec<String>,
    /// `false` marks a slug no picker should offer — it aged out of the list,
    /// or is an internal one. The account can still call a model it already
    /// saved, so the entry is kept and marked rather than dropped.
    pub listed: bool,
}

fn normalize_model(item: &Value) -> Option<SubscriptionModel> {
    let slug = item.get("slug").and_then(|v| v.as_str())?;
    if slug.is_empty() || slug.len() > 128 {
        return None;
    }
    let display_name = item
        .get("display_name")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .unwrap_or(slug);
    Some(SubscriptionModel {
        id: slug.to_string(),
        display_name: display_name.to_string(),
        // `as_u64` already rejects a JSON `true`, which would otherwise be
        // reported to the picker as a context length of its own.
        context_length: item.get("context_window").and_then(|v| v.as_u64()),
        vision: item
            .get("input_modalities")
            .and_then(|v| v.as_array())
            .map(|m| m.iter().any(|x| x.as_str() == Some("image")))
            .unwrap_or(false),
        reasoning_efforts: item
            .get("supported_reasoning_levels")
            .and_then(|v| v.as_array())
            .map(|levels| {
                levels
                    .iter()
                    .filter_map(|l| l.get("effort").and_then(|e| e.as_str()))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        listed: item.get("visibility").and_then(|v| v.as_str()) == Some("list"),
    })
}

/// Ask the subscription what it can serve.
///
/// There is no curated fallback here on purpose: a made-up catalogue puts
/// models in the picker that the account may not carry, and every send then
/// fails with no explanation.
pub async fn list_models(
    client: &Client,
    auth: &ChatGptAuthState,
    data_dir: &std::path::Path,
) -> Result<Vec<SubscriptionModel>, String> {
    let mut forced = false;
    let response = loop {
        let token = auth.access_token(data_dir, forced).await?;
        let sent = client
            .get(format!("{CHATGPT_BASE_URL}/models"))
            .query(&[("client_version", CLIENT_VERSION)])
            .header("Authorization", format!("Bearer {}", token.token))
            .header("Accept", "application/json")
            .header("originator", ORIGINATOR)
            .header("User-Agent", USER_AGENT);
        let sent = match token.account_id.as_deref() {
            Some(account) => sent.header("chatgpt-account-id", account),
            None => sent,
        };

        match sent.send().await {
            Err(err) => return Err(format!("Could not reach ChatGPT: {err}")),
            // The upstream can reject a token before its recorded expiry while
            // the refresh credential is still good — spend one forced refresh
            // on that, the way the streaming path does.
            Ok(resp) if resp.status() == reqwest::StatusCode::UNAUTHORIZED && !forced => {
                forced = true;
                continue;
            }
            Ok(resp) => break resp,
        }
    };

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("Could not read the ChatGPT model list: {e}"))?;
    if !status.is_success() {
        return Err(format!("Could not list ChatGPT models ({status}): {body}"));
    }

    let parsed: Value = serde_json::from_str(&body)
        .map_err(|e| format!("ChatGPT returned an unreadable model list: {e}"))?;
    let mut seen = std::collections::HashSet::new();
    let models = parsed
        .get("models")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(normalize_model)
                // A slug repeated in one payload describes itself twice; first
                // wins so the list and anything keyed off it agree.
                .filter(|m| seen.insert(m.id.clone()))
                .collect()
        })
        .unwrap_or_default();
    Ok(models)
}

/// Outcome of looking at a `/chat/completions` request.
pub enum ChatGptRouting {
    /// The request was for the subscription and is fully answered.
    Handled(Response<Body>),
    /// Not ours. The buffered body is handed back so the generic path can
    /// carry on with it — reading a `Body` consumes it.
    NotSubscription(Bytes),
}

/// Is this model served by the connected subscription?
pub fn is_subscription_model(provider_name: Option<&str>) -> bool {
    provider_name == Some(CHATGPT_PROVIDER)
}

fn build_upstream_request(
    client: &Client,
    access_token: &str,
    account_id: Option<&str>,
    session_id: &str,
    request_id: &str,
    payload: &Value,
) -> reqwest::RequestBuilder {
    let mut req = client
        .post(format!("{CHATGPT_BASE_URL}/responses"))
        .header("Authorization", format!("Bearer {access_token}"))
        .header("Accept", "text/event-stream")
        .header("Content-Type", "application/json")
        .header("OpenAI-Beta", "responses=experimental")
        .header("originator", ORIGINATOR)
        .header("User-Agent", USER_AGENT)
        // Hyphen, not underscore: the backend reads `session-id`, and it keeps
        // one conversation on one upstream shard.
        .header("session-id", session_id)
        .header("x-client-request-id", request_id);
    if let Some(account) = account_id {
        req = req.header("chatgpt-account-id", account);
    }
    req.json(payload)
}

/// Serve one `/chat/completions` request from the subscription.
///
/// `stream` follows the client's request: the upstream only streams, so a
/// non-streaming client gets the aggregate of that stream rather than a second
/// round trip.
#[allow(clippy::too_many_arguments)]
pub async fn respond(
    client: &Client,
    auth: &ChatGptAuthState,
    data_dir: &std::path::Path,
    request_body: &Value,
    stream: bool,
    created: u64,
    session_id: &str,
    // `Send + Sync` so the returned future stays `Send`: hyper's executor
    // requires it, and these are held across the upstream await.
    make_err: &(dyn Fn(StatusCode, &str) -> Response<Body> + Send + Sync),
    ok_builder: &(dyn Fn(&str) -> hyper::http::response::Builder + Send + Sync),
) -> Response<Body> {
    // Stable per-conversation key so the upstream can reuse its prompt cache
    // across the turns of one thread; also the session affinity header.
    let payload =
        crate::core::server::chat_to_responses_shim::chat_request_to_responses(request_body, session_id);
    let model_id = request_body
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    let request_id = uuid::Uuid::new_v4().simple().to_string();

    // One forced refresh on a 401: the server's opinion of the token outranks
    // our expiry arithmetic. Anything else is reported as-is.
    let mut forced = false;
    let response = loop {
        let token = match auth.access_token(data_dir, forced).await {
            Ok(token) => token,
            Err(err) => {
                return make_err(StatusCode::UNAUTHORIZED, &err);
            }
        };

        let sent = build_upstream_request(
            client,
            &token.token,
            token.account_id.as_deref(),
            session_id,
            &request_id,
            &payload,
        )
        .send()
        .await;

        match sent {
            Err(err) => {
                return make_err(
                    StatusCode::BAD_GATEWAY,
                    &format!("ChatGPT subscription request failed: {err}"),
                );
            }
            Ok(resp) if resp.status() == reqwest::StatusCode::UNAUTHORIZED && !forced => {
                forced = true;
                continue;
            }
            Ok(resp) => break resp,
        }
    };

    let status = response.status();
    if !status.is_success() {
        // Pass the upstream body through verbatim. Subscription quotas are
        // opaque and per-account; a generic "upstream error" would leave a
        // rate-limited user with nothing to act on.
        let body = response
            .text()
            .await
            .unwrap_or_else(|e| format!("Failed to read error body: {e}"));
        let code = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        return make_err(code, &body);
    }

    if !stream {
        let mut conv = ChatChunkStreamConverter::new(model_id, created);
        let mut upstream = response.bytes_stream();
        let mut reader = SseLineReader::new();

        while let Some(chunk) = upstream.next().await {
            let Ok(bytes) = chunk else { break };
            reader.push(&bytes);
            while let Some(line) = reader.next_line() {
                let SseLine::Data { payload, .. } = line else {
                    continue;
                };
                match payload {
                    SseData::Json(event) => {
                        conv.on_event(&event);
                    }
                    SseData::Done => break,
                    SseData::Raw(_) => {}
                }
            }
        }

        if let Some(error) = conv.error() {
            let message = error.to_string();
            return make_err(StatusCode::BAD_GATEWAY, &message);
        }
        let completion = conv.into_chat_completion();
        return ok_builder("application/json")
            .body(Body::from(completion.to_string()))
            .expect("static JSON response");
    }

    let (mut sender, body) = Body::channel();
    let mut conv = ChatChunkStreamConverter::new(model_id, created);

    tokio::spawn(async move {
        let mut upstream = response.bytes_stream();
        let mut reader = SseLineReader::new();

        'outer: while let Some(chunk) = upstream.next().await {
            let bytes = match chunk {
                Ok(bytes) => bytes,
                Err(err) => {
                    log::error!("[chatgpt] upstream stream error: {err}");
                    break;
                }
            };
            reader.push(&bytes);

            while let Some(line) = reader.next_line() {
                let SseLine::Data { payload, .. } = line else {
                    continue;
                };
                match payload {
                    SseData::Json(event) => {
                        for chunk in conv.on_event(&event) {
                            if sender.send_data(sse_event(&chunk)).await.is_err() {
                                break 'outer;
                            }
                        }
                    }
                    SseData::Done => break 'outer,
                    SseData::Raw(_) => {}
                }
            }
        }

        // Whatever ended the stream, the client is owed a finish chunk and the
        // `[DONE]` sentinel it is blocking on.
        for chunk in conv.finish() {
            let _ = sender.send_data(sse_event(&chunk)).await;
        }
        let _ = sender.send_data(Bytes::from_static(b"data: [DONE]\n\n")).await;
    });

    ok_builder("text/event-stream")
        .header(hyper::header::CACHE_CONTROL, "no-cache")
        .body(body)
        .expect("streaming response")
}

fn sse_event(value: &Value) -> Bytes {
    Bytes::from(format!("data: {value}\n\n"))
}

/// A `reqwest` client for this endpoint: long timeout for a long generation,
/// and no proxy surprises beyond the app's own configuration.
pub fn client() -> Result<Client, String> {
    Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("cannot build the ChatGPT HTTP client: {e}"))
}
