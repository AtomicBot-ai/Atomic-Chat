//! OpenAI-compatible `/v1/chat/completions` transport for the agent loop.
//!
//! One implementation serves two targets, differing only in how the
//! [`OpenAiTarget`] is assembled:
//!
//! - [`OpenAiTargetKind::LocalMlx`] — straight at the `mlx-server` session
//!   port, mirroring what `ModelFactory.createMlxModel` does for regular chat.
//!   Keeps a fully local run independent of the Local API Server.
//! - [`OpenAiTargetKind::LocalApiServer`] — at the Local API Server proxy,
//!   which resolves the cloud provider by model id, swaps in that provider's
//!   key and custom headers, and translates Anthropic `/messages`. This mirrors
//!   `getLocalApiServerBaseURL` on the chat path, so no provider credential
//!   ever reaches this module.
//!
//! The wire contract is the same text JSON-array of `{tool, args}` the GBNF
//! path produces; `response_format` (see [`super::tool_schema`]) tightens it
//! where the target is known to honour an array-root schema, and the runner's
//! repair step covers the rest.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use async_trait::async_trait;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

use crate::core::server::context_expansion::is_context_limit_error;

use super::llm_client::{
    extract_error_detail, model_ids_match, AgentClientCapabilities, AgentLlmClient, AgentPrompt,
    AuthErrorSource, CompletionReasoning, CompletionRequest, CompletionResult, CompletionTiming,
    LlmClientError,
};
use super::model_profile::AgentModelProfile;

const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(600);
/// Upper bound on how long a `Retry-After` may park an agent step.
const MAX_RETRY_AFTER: Duration = Duration::from_secs(20);
const TRANSIENT_RETRY_DELAY: Duration = Duration::from_secs(1);
const VISION_MAX_TOKENS: u32 = 1024;

/// Where an OpenAI-compatible request is sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenAiTargetKind {
    /// A local `mlx-server` process on loopback.
    LocalMlx,
    /// The Local API Server proxy, which fans out to the real provider.
    LocalApiServer,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenAiTarget {
    pub kind: OpenAiTargetKind,
    /// Origin plus version prefix, no trailing slash (e.g.
    /// `http://127.0.0.1:1337/v1`).
    pub base_url: String,
    /// For `LocalMlx` this is the session key (usually empty); for
    /// `LocalApiServer` it is the *Local API Server's* own key, never a
    /// provider's.
    pub api_key: Option<String>,
    pub model_id: String,
    pub has_vision: bool,
    pub context_window: Option<usize>,
    /// Whether an array-root `response_format` is known to work here.
    pub json_schema: bool,
}

/// Asks the owning local backend to reload the model with a larger context.
///
/// Deliberately separate from `llm_client::ContextExpansionHook`: that one
/// speaks `LlamaSessionTarget` and guards the llama backend identity, which has
/// no meaning here. A reload spawns a new process, so the replacement carries a
/// new port.
#[async_trait]
pub trait SessionReloadHook: Send + Sync {
    async fn reload_with_larger_context(
        &self,
        target: &OpenAiTarget,
        cancellation: &CancellationToken,
    ) -> Result<OpenAiTarget, String>;
}

pub struct OpenAiCompatibleClient {
    client: reqwest::Client,
    target: RwLock<OpenAiTarget>,
    session_reload: Option<Arc<dyn SessionReloadHook>>,
    /// Set once a target rejects `response_format`, so the wasted request is
    /// paid once per run instead of once per step.
    schema_disabled: AtomicBool,
    /// Set once a target rejects `max_tokens` in favour of
    /// `max_completion_tokens` (newer OpenAI reasoning models).
    use_max_completion_tokens: AtomicBool,
    /// Set once a target rejects a reasoning field, so the run drops them
    /// rather than burning one failed request per step.
    reasoning_disabled: AtomicBool,
}

impl OpenAiCompatibleClient {
    pub fn new(target: OpenAiTarget) -> Result<Self, LlmClientError> {
        // Both target kinds are loopback; an ambient HTTP proxy must not
        // intercept them.
        let client = reqwest::Client::builder()
            .timeout(DEFAULT_REQUEST_TIMEOUT)
            .no_proxy()
            .build()
            .map_err(|error| LlmClientError::Transport(error.to_string()))?;
        Ok(Self {
            client,
            target: RwLock::new(target),
            session_reload: None,
            schema_disabled: AtomicBool::new(false),
            use_max_completion_tokens: AtomicBool::new(false),
            reasoning_disabled: AtomicBool::new(false),
        })
    }

    pub fn with_session_reload(mut self, hook: Arc<dyn SessionReloadHook>) -> Self {
        self.session_reload = Some(hook);
        self
    }

    pub fn target(&self) -> OpenAiTarget {
        self.target
            .read()
            .expect("openai target lock poisoned")
            .clone()
    }

    pub fn retarget(&self, target: &OpenAiTarget) {
        *self.target.write().expect("openai target lock poisoned") = target.clone();
    }

    async fn post_chat(
        &self,
        target: &OpenAiTarget,
        payload: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, LlmClientError> {
        let mut builder = self
            .client
            .post(format!("{}/chat/completions", target.base_url))
            .header(CONTENT_TYPE, "application/json")
            .header(ACCEPT, "application/json")
            .json(payload);
        if let Some(api_key) = target.api_key.as_deref().filter(|key| !key.is_empty()) {
            builder = builder.header(AUTHORIZATION, format!("Bearer {api_key}"));
        }
        let response = tokio::select! {
            _ = cancellation.cancelled() => return Err(LlmClientError::Cancelled),
            result = builder.send() => match result {
                Ok(response) => response,
                Err(error) => return Err(connection_error(target.kind, &error)),
            }
        };
        let status = response.status();
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse::<u64>().ok());
        let bytes = tokio::select! {
            _ = cancellation.cancelled() => return Err(LlmClientError::Cancelled),
            result = response.bytes() => {
                result.map_err(|error| LlmClientError::Transport(error.to_string()))?
            }
        };
        if !status.is_success() {
            let body = String::from_utf8_lossy(&bytes);
            return Err(classify_error(status.as_u16(), &body, retry_after));
        }
        serde_json::from_slice(&bytes)
            .map_err(|error| LlmClientError::InvalidResponse(error.to_string()))
    }

    /// Runs one completion, applying the degrade ladder. Each rung retries at
    /// most once, and each sets a sticky flag so the next step starts from the
    /// already-corrected shape.
    async fn complete_with_degrade(
        &self,
        target: &OpenAiTarget,
        request: &CompletionRequest,
        cancellation: &CancellationToken,
    ) -> Result<CompletionResult, LlmClientError> {
        let payload = self.chat_payload(target, request);
        match self.post_chat(target, &payload, cancellation).await {
            Ok(value) => parse_chat_response(&value),
            Err(LlmClientError::RateLimited { retry_after_secs }) => {
                let delay = retry_after_secs
                    .map(Duration::from_secs)
                    .unwrap_or(TRANSIENT_RETRY_DELAY)
                    .min(MAX_RETRY_AFTER);
                sleep_or_cancel(delay, cancellation).await?;
                let value = self.post_chat(target, &payload, cancellation).await?;
                parse_chat_response(&value)
            }
            Err(LlmClientError::Http { status, detail })
                if status == 400 && mentions_schema_rejection(&detail) =>
            {
                log::info!(
                    "Disabling response_format for this run: the model server rejected the \
                     tool-call schema ({detail})"
                );
                self.schema_disabled.store(true, Ordering::SeqCst);
                let retry = self.chat_payload(target, request);
                let value = self.post_chat(target, &retry, cancellation).await?;
                parse_chat_response(&value)
            }
            Err(LlmClientError::Http { status, detail })
                if status == 400
                    && mentions_reasoning_rejection(&detail)
                    && !self.reasoning_disabled.load(Ordering::SeqCst) =>
            {
                log::info!(
                    "Dropping the reasoning fields for this run: the model server rejected \
                     them ({detail})"
                );
                self.reasoning_disabled.store(true, Ordering::SeqCst);
                let retry = self.chat_payload(target, request);
                let value = self.post_chat(target, &retry, cancellation).await?;
                parse_chat_response(&value)
            }
            Err(LlmClientError::Http { status, detail })
                if status == 400 && mentions_max_tokens_rename(&detail) =>
            {
                self.use_max_completion_tokens.store(true, Ordering::SeqCst);
                let retry = self.chat_payload(target, request);
                let value = self.post_chat(target, &retry, cancellation).await?;
                parse_chat_response(&value)
            }
            Err(LlmClientError::Http { status, detail }) if is_transient_gateway(status) => {
                log::warn!("Retrying agent completion after HTTP {status}: {detail}");
                sleep_or_cancel(TRANSIENT_RETRY_DELAY, cancellation).await?;
                let value = self.post_chat(target, &payload, cancellation).await?;
                parse_chat_response(&value)
            }
            Err(error) => Err(error),
        }
    }

    fn chat_payload(&self, target: &OpenAiTarget, request: &CompletionRequest) -> Value {
        let mut body = Map::new();
        body.insert("model".into(), json!(target.model_id));
        body.insert("messages".into(), json!(prompt_messages(&request.prompt)));
        body.insert("stream".into(), json!(false));
        body.insert("temperature".into(), json!(request.temperature));
        body.insert("top_p".into(), json!(request.top_p));
        // Standard OpenAI parameters, sent only when the turn set them so
        // default request bodies stay byte-identical.
        if let Some(frequency_penalty) = request.frequency_penalty {
            body.insert("frequency_penalty".into(), json!(frequency_penalty));
        }
        if let Some(presence_penalty) = request.presence_penalty {
            body.insert("presence_penalty".into(), json!(presence_penalty));
        }

        // `top_k`, `min_p`, `repeat_penalty` and `repeat_last_n` are llama.cpp
        // samplers. OpenAI and Groq answer 400 on unknown parameters, so they
        // never leave the request struct.
        let token_key = if self.use_max_completion_tokens.load(Ordering::SeqCst) {
            "max_completion_tokens"
        } else {
            "max_tokens"
        };
        body.insert(token_key.into(), json!(request.max_tokens));

        if !request.stop.is_empty() {
            body.insert("stop".into(), json!(request.stop));
        }
        if target.json_schema && !self.schema_disabled.load(Ordering::SeqCst) {
            if let Some(schema) = request.response_schema.as_deref() {
                body.insert("response_format".into(), schema.clone());
            }
        }
        if !self.reasoning_disabled.load(Ordering::SeqCst) {
            insert_reasoning_fields(&mut body, target, &request.reasoning);
        }
        Value::Object(body)
    }
}

/// Turns the resolved intent into request fields.
///
/// mlx-vlm reads a top-level `reasoning_effort` / `thinking_budget` and hands
/// them to the chat template. Cloud targets get nothing when thinking is on —
/// they think by default and we have no template to tell us which values are
/// legal — and only a suppression hint when it is off, which is what the chat
/// transport does for the same providers.
fn insert_reasoning_fields(
    body: &mut Map<String, Value>,
    target: &OpenAiTarget,
    reasoning: &CompletionReasoning,
) {
    let is_mlx = target.kind == OpenAiTargetKind::LocalMlx;
    match reasoning {
        CompletionReasoning::Unset => {}
        CompletionReasoning::Off => {
            if is_mlx {
                body.insert(
                    "chat_template_kwargs".into(),
                    json!({"enable_thinking": false}),
                );
                body.insert("enable_thinking".into(), json!(false));
            }
        }
        CompletionReasoning::On {
            budget_tokens,
            effort_value,
            ..
        } => {
            if !is_mlx {
                return;
            }
            body.insert("enable_thinking".into(), json!(true));
            if let Some(effort) = effort_value {
                body.insert("reasoning_effort".into(), json!(effort));
            } else if let Some(tokens) = budget_tokens {
                body.insert("thinking_budget".into(), json!(tokens));
            }
        }
    }
}

/// Whether a 400 blames one of the reasoning fields we added. Checked only
/// after [`mentions_schema_rejection`], which names a more specific cause.
fn mentions_reasoning_rejection(detail: &str) -> bool {
    let detail = detail.to_ascii_lowercase();
    [
        "reasoning_effort",
        "thinking_budget",
        "enable_thinking",
        "chat_template_kwargs",
    ]
    .iter()
    .any(|field| detail.contains(field))
}

#[async_trait]
impl AgentLlmClient for OpenAiCompatibleClient {
    fn capabilities(&self) -> AgentClientCapabilities {
        AgentClientCapabilities {
            grammar: false,
            json_schema: self.target().json_schema,
            prompt_cache_slots: false,
        }
    }

    fn model_id(&self) -> String {
        self.target().model_id
    }

    fn has_vision(&self) -> bool {
        self.target().has_vision
    }

    /// Always [`AgentModelProfile::Plain`], without a request.
    ///
    /// `Gemma4Think` hand-emits the turn framing (`<|turn>system`,
    /// `<|channel>thought`) that llama.cpp's raw `/completion` endpoint skips.
    /// A `/v1/chat/completions` server applies the model's own chat template,
    /// so emitting the framing here would double-apply it. Reasoning still
    /// survives: `Plain` routes the parser through `extract_reasoning` (which
    /// strips `<think>` blocks) and this transport lifts `reasoning_content` /
    /// `reasoning` out of the message envelope separately.
    async fn probe_model_profile(&self, _cancellation: &CancellationToken) -> AgentModelProfile {
        AgentModelProfile::Plain
    }

    /// No HTTP: there is no portable `/props` equivalent, so the window is
    /// whatever the frontend knew when it started the turn. `None` is safe —
    /// `compute_effective_conversation_cap` falls back to the configured cap.
    async fn fetch_context_window(
        &self,
        _cancellation: &CancellationToken,
    ) -> Result<Option<usize>, LlmClientError> {
        Ok(self.target().context_window)
    }

    async fn complete(
        &self,
        request: &CompletionRequest,
        cancellation: &CancellationToken,
    ) -> Result<CompletionResult, LlmClientError> {
        let target = self.target();
        match self
            .complete_with_degrade(&target, request, cancellation)
            .await
        {
            Err(LlmClientError::ContextOverflow(detail)) if self.session_reload.is_some() => {
                let hook = self.session_reload.as_ref().expect("session reload hook");
                let replacement = match hook.reload_with_larger_context(&target, cancellation).await
                {
                    Ok(replacement) => replacement,
                    Err(_) if cancellation.is_cancelled() => return Err(LlmClientError::Cancelled),
                    Err(error) => {
                        log::warn!("Agent context expansion failed: {error}");
                        return Err(LlmClientError::ContextOverflow(detail));
                    }
                };
                if replacement.kind != target.kind
                    || !model_ids_match(&replacement.model_id, &target.model_id)
                {
                    return Err(LlmClientError::Transport(
                        "Context expansion returned a different model or backend".into(),
                    ));
                }
                self.retarget(&replacement);
                self.complete_with_degrade(&replacement, request, cancellation)
                    .await
            }
            result => result,
        }
    }

    async fn describe_images(
        &self,
        prompt: &str,
        images: &[(String, String)],
        cancellation: &CancellationToken,
    ) -> Result<String, LlmClientError> {
        let target = self.target();
        // Re-checked at execution time, not just at staging: the session may
        // have been swapped for a text-only model mid-turn, and a structured
        // tool error beats a guessed description.
        if !target.has_vision {
            return Err(LlmClientError::InvalidResponse(
                "the active model is not vision-capable".into(),
            ));
        }
        let payload = vision_payload(&target, prompt, images);
        let value = self.post_chat(&target, &payload, cancellation).await?;
        value
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_owned)
            .ok_or_else(|| {
                LlmClientError::InvalidResponse(
                    "vision response did not contain message content".into(),
                )
            })
    }
}

/// A `None` system half means the caller had one flat string; sending it as a
/// lone user message keeps the conversion total.
fn prompt_messages(prompt: &AgentPrompt) -> Vec<Value> {
    match prompt.system.as_deref() {
        Some(system) => vec![
            json!({"role": "system", "content": system}),
            json!({"role": "user", "content": prompt.body}),
        ],
        None => vec![json!({"role": "user", "content": prompt.body})],
    }
}

fn vision_payload(target: &OpenAiTarget, prompt: &str, images: &[(String, String)]) -> Value {
    let mut content = images
        .iter()
        .map(|(media_type, base64)| {
            json!({
                "type": "image_url",
                "image_url": {"url": format!("data:{media_type};base64,{base64}")}
            })
        })
        .collect::<Vec<_>>();
    content.push(json!({"type": "text", "text": prompt}));

    let mut body = Map::new();
    body.insert("model".into(), json!(target.model_id));
    body.insert(
        "messages".into(),
        json!([{"role": "user", "content": content}]),
    );
    body.insert("stream".into(), json!(false));
    body.insert("max_tokens".into(), json!(VISION_MAX_TOKENS));
    body.insert("temperature".into(), json!(0.2));
    if target.kind == OpenAiTargetKind::LocalMlx {
        // Documented mlx-vlm knob. Cloud providers reject unknown fields, and
        // `reasoning_format` is a llama.cpp-server extension that has no
        // meaning on either target here.
        body.insert(
            "chat_template_kwargs".into(),
            json!({"enable_thinking": false}),
        );
    }
    Value::Object(body)
}

pub(crate) fn parse_chat_response(value: &Value) -> Result<CompletionResult, LlmClientError> {
    let message = value.pointer("/choices/0/message").ok_or_else(|| {
        LlmClientError::InvalidResponse("response did not contain choices[0].message".into())
    })?;
    let content = message
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    // `reasoning_content` is the DeepSeek / mlx-vlm spelling; `reasoning` is
    // OpenRouter's. Inline `<think>` blocks need no handling here — the shared
    // parser strips them.
    let reasoning_content = message
        .get("reasoning_content")
        .and_then(Value::as_str)
        .or_else(|| message.get("reasoning").and_then(Value::as_str))
        .unwrap_or_default()
        .to_owned();
    let finish_reason = value
        .pointer("/choices/0/finish_reason")
        .and_then(Value::as_str)
        .unwrap_or_default();

    // OpenAI's `usage.prompt_tokens` is the TOTAL prompt (cached included),
    // while llama.cpp's `tokens_evaluated` excludes cache hits. Normalize to
    // the llama.cpp convention — `prompt_tokens` = newly evaluated,
    // `cache_hit_tokens` = reused — so consumers may sum the two.
    let cached_tokens = value
        .pointer("/usage/prompt_tokens_details/cached_tokens")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    Ok(CompletionResult {
        content,
        reasoning_content,
        stop: finish_reason == "stop",
        truncated: finish_reason == "length",
        timing: CompletionTiming {
            // Chat completions report token counts but no wall-clock split.
            prompt_ms: 0.0,
            predicted_ms: 0.0,
            prompt_tokens: (usage_number(value, "prompt_tokens") - cached_tokens).max(0.0),
            predicted_tokens: usage_number(value, "completion_tokens"),
        },
        cache_hit_tokens: cached_tokens,
        // No slot pinning on this transport.
        slot_id: -1,
        model_id: value
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

fn usage_number(value: &Value, key: &str) -> f64 {
    value
        .pointer(&format!("/usage/{key}"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
}

pub(crate) fn classify_error(status: u16, body: &str, retry_after: Option<u64>) -> LlmClientError {
    let detail = extract_error_detail(body);
    match status {
        401 | 403 => LlmClientError::Unauthorized {
            origin: auth_error_source(body),
        },
        404 | 503 if mentions_missing_session(&detail) => {
            LlmClientError::SessionNotFound(detail.clone())
        }
        429 => LlmClientError::RateLimited {
            retry_after_secs: retry_after,
        },
        400 if is_context_limit_error(status, &detail) => LlmClientError::ContextOverflow(detail),
        _ => LlmClientError::Http { status, detail },
    }
}

/// The proxy's own auth gate answers with a flat text body; a provider (or the
/// model server) answers with JSON. Telling them apart is what lets the UI say
/// "check the Local API Server key" instead of "check your provider key".
fn auth_error_source(body: &str) -> AuthErrorSource {
    let trimmed = body.trim();
    if serde_json::from_str::<Value>(trimmed).is_ok() {
        AuthErrorSource::Upstream
    } else {
        AuthErrorSource::LocalServer
    }
}

fn mentions_missing_session(detail: &str) -> bool {
    let lowered = detail.to_ascii_lowercase();
    lowered.contains("no running session found") || lowered.contains("no models are available")
}

fn mentions_schema_rejection(detail: &str) -> bool {
    let lowered = detail.to_ascii_lowercase();
    ["response_format", "json_schema", "structured", "schema"]
        .iter()
        .any(|needle| lowered.contains(needle))
        // mlx-vlm cannot combine structured output with a draft model.
        || lowered.contains("speculative")
        || lowered.contains("draft")
}

fn mentions_max_tokens_rename(detail: &str) -> bool {
    let lowered = detail.to_ascii_lowercase();
    lowered.contains("max_completion_tokens")
        || (lowered.contains("max_tokens") && lowered.contains("unsupported"))
}

fn is_transient_gateway(status: u16) -> bool {
    matches!(status, 502..=504)
}

fn connection_error(kind: OpenAiTargetKind, error: &reqwest::Error) -> LlmClientError {
    if kind == OpenAiTargetKind::LocalApiServer && (error.is_connect() || error.is_timeout()) {
        return LlmClientError::LocalServerUnavailable;
    }
    LlmClientError::Transport(error.to_string())
}

async fn sleep_or_cancel(
    delay: Duration,
    cancellation: &CancellationToken,
) -> Result<(), LlmClientError> {
    tokio::select! {
        _ = cancellation.cancelled() => Err(LlmClientError::Cancelled),
        _ = tokio::time::sleep(delay) => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::agent::llm_client::{CompletionRequest, ReasoningTags};

    fn target(kind: OpenAiTargetKind, json_schema: bool) -> OpenAiTarget {
        OpenAiTarget {
            kind,
            base_url: "http://127.0.0.1:1234/v1".into(),
            api_key: None,
            model_id: "test-model".into(),
            has_vision: false,
            context_window: Some(16_384),
            json_schema,
        }
    }

    fn request_with_schema() -> CompletionRequest {
        CompletionRequest::tool_call_parts(
            AgentPrompt::parts("STABLE", "### conversation\nuser: hi"),
            None,
            Some(Arc::new(json!({
                "type": "json_schema",
                "json_schema": {"name": "atomic_agent_tool_calls"}
            }))),
            0,
        )
    }

    #[test]
    fn payload_splits_the_prompt_and_omits_llama_only_samplers() {
        let client = OpenAiCompatibleClient::new(target(OpenAiTargetKind::LocalMlx, true)).unwrap();
        let payload = client.chat_payload(&client.target(), &request_with_schema());

        assert_eq!(payload["messages"][0]["role"], json!("system"));
        assert_eq!(payload["messages"][0]["content"], json!("STABLE"));
        assert_eq!(payload["messages"][1]["role"], json!("user"));
        assert!(payload["messages"][1]["content"]
            .as_str()
            .unwrap()
            .contains("### conversation"));
        assert_eq!(payload["stream"], json!(false));
        assert_eq!(payload["max_tokens"], json!(8_192));

        for absent in [
            "prompt",
            "grammar",
            "cache_prompt",
            "slot_id",
            "id_slot",
            "n_predict",
            "top_k",
            "repeat_penalty",
            "repeat_last_n",
        ] {
            assert!(
                payload.get(absent).is_none(),
                "chat payload must not carry llama.cpp field `{absent}`"
            );
        }
    }

    #[test]
    fn flat_prompt_becomes_a_single_user_message() {
        let client = OpenAiCompatibleClient::new(target(OpenAiTargetKind::LocalMlx, true)).unwrap();
        let request = CompletionRequest::tool_call("flat prompt", "root ::= \"x\"", 0);
        let payload = client.chat_payload(&client.target(), &request);

        assert_eq!(payload["messages"].as_array().unwrap().len(), 1);
        assert_eq!(payload["messages"][0]["role"], json!("user"));
        assert_eq!(payload["messages"][0]["content"], json!("flat prompt"));
    }

    #[test]
    fn response_format_follows_the_target_and_the_degrade_flag() {
        let capable =
            OpenAiCompatibleClient::new(target(OpenAiTargetKind::LocalMlx, true)).unwrap();
        let payload = capable.chat_payload(&capable.target(), &request_with_schema());
        assert_eq!(
            payload["response_format"]["json_schema"]["name"],
            json!("atomic_agent_tool_calls")
        );

        capable.schema_disabled.store(true, Ordering::SeqCst);
        let degraded = capable.chat_payload(&capable.target(), &request_with_schema());
        assert!(degraded.get("response_format").is_none());

        let incapable =
            OpenAiCompatibleClient::new(target(OpenAiTargetKind::LocalApiServer, false)).unwrap();
        let payload = incapable.chat_payload(&incapable.target(), &request_with_schema());
        assert!(payload.get("response_format").is_none());
    }

    fn request_with_reasoning(reasoning: CompletionReasoning) -> CompletionRequest {
        CompletionRequest {
            reasoning,
            ..CompletionRequest::tool_call_parts(
                AgentPrompt::parts("STABLE", "### conversation\nuser: hi"),
                None,
                None,
                0,
            )
        }
    }

    #[test]
    fn mlx_gets_the_declared_effort_value_when_thinking_is_on() {
        let client =
            OpenAiCompatibleClient::new(target(OpenAiTargetKind::LocalMlx, false)).unwrap();
        let payload = client.chat_payload(
            &client.target(),
            &request_with_reasoning(CompletionReasoning::On {
                tags: ReasoningTags {
                    open: "<think>",
                    close: "</think>",
                },
                budget_tokens: Some(4_096),
                effort_value: Some("high".into()),
            }),
        );

        assert_eq!(payload["enable_thinking"], json!(true));
        assert_eq!(payload["reasoning_effort"], json!("high"));
        // A model driven by a named effort takes no token budget.
        assert!(payload.get("thinking_budget").is_none());
    }

    #[test]
    fn mlx_falls_back_to_a_token_budget_without_a_declared_effort() {
        let client =
            OpenAiCompatibleClient::new(target(OpenAiTargetKind::LocalMlx, false)).unwrap();
        let payload = client.chat_payload(
            &client.target(),
            &request_with_reasoning(CompletionReasoning::On {
                tags: ReasoningTags {
                    open: "<think>",
                    close: "</think>",
                },
                budget_tokens: Some(1_024),
                effort_value: None,
            }),
        );

        assert_eq!(payload["thinking_budget"], json!(1_024));
        assert!(payload.get("reasoning_effort").is_none());
    }

    #[test]
    fn mlx_suppression_disables_thinking_both_ways() {
        let client =
            OpenAiCompatibleClient::new(target(OpenAiTargetKind::LocalMlx, false)).unwrap();
        let payload = client.chat_payload(
            &client.target(),
            &request_with_reasoning(CompletionReasoning::Off),
        );

        // mlx-vlm reads the top-level field; the kwargs bag is what older
        // builds and the templates themselves look at.
        assert_eq!(payload["enable_thinking"], json!(false));
        assert_eq!(
            payload["chat_template_kwargs"],
            json!({"enable_thinking": false})
        );
    }

    #[test]
    fn cloud_targets_get_no_reasoning_fields() {
        let client =
            OpenAiCompatibleClient::new(target(OpenAiTargetKind::LocalApiServer, false)).unwrap();
        for reasoning in [
            CompletionReasoning::Off,
            CompletionReasoning::On {
                tags: ReasoningTags {
                    open: "<think>",
                    close: "</think>",
                },
                budget_tokens: Some(1_024),
                effort_value: Some("high".into()),
            },
        ] {
            let payload = client.chat_payload(&client.target(), &request_with_reasoning(reasoning));

            // We have no chat template for a cloud model, so any value we could
            // send would be a guess — and strict schemas 400 on a wrong one.
            for field in [
                "reasoning_effort",
                "thinking_budget",
                "enable_thinking",
                "chat_template_kwargs",
            ] {
                assert!(payload.get(field).is_none(), "unexpected {field}");
            }
        }
    }

    #[test]
    fn reasoning_fields_are_dropped_once_a_target_rejects_them() {
        let client =
            OpenAiCompatibleClient::new(target(OpenAiTargetKind::LocalMlx, false)).unwrap();
        let request = request_with_reasoning(CompletionReasoning::On {
            tags: ReasoningTags {
                open: "<think>",
                close: "</think>",
            },
            budget_tokens: None,
            effort_value: Some("high".into()),
        });
        assert!(client
            .chat_payload(&client.target(), &request)
            .get("reasoning_effort")
            .is_some());

        client.reasoning_disabled.store(true, Ordering::SeqCst);

        assert!(client
            .chat_payload(&client.target(), &request)
            .get("reasoning_effort")
            .is_none());
    }

    #[test]
    fn a_schema_rejection_wins_over_the_reasoning_arm() {
        // Both matchers fire on this one; the schema cause is the specific one
        // and its ladder rung is checked first.
        let detail = "response_format.json_schema is not supported with reasoning_effort";
        assert!(mentions_schema_rejection(detail));
        assert!(mentions_reasoning_rejection(detail));
        assert!(!mentions_reasoning_rejection("context window exceeded"));
    }

    #[test]
    fn max_tokens_key_switches_after_a_rename_rejection() {
        let client =
            OpenAiCompatibleClient::new(target(OpenAiTargetKind::LocalApiServer, false)).unwrap();
        client
            .use_max_completion_tokens
            .store(true, Ordering::SeqCst);
        let payload = client.chat_payload(&client.target(), &request_with_schema());

        assert!(payload.get("max_tokens").is_none());
        assert_eq!(payload["max_completion_tokens"], json!(8_192));
    }

    #[test]
    fn parses_content_usage_and_finish_reason() {
        let value = json!({
            "model": "served-model",
            "choices": [{
                "message": {"content": "[{\"tool\":\"reply\",\"args\":{}}]"},
                "finish_reason": "stop"
            }],
            "usage": {
                "prompt_tokens": 120,
                "completion_tokens": 8,
                "prompt_tokens_details": {"cached_tokens": 64}
            }
        });
        let result = parse_chat_response(&value).unwrap();

        assert_eq!(result.content, "[{\"tool\":\"reply\",\"args\":{}}]");
        assert!(result.stop);
        assert!(!result.truncated);
        // Normalized to llama.cpp semantics: `prompt_tokens` excludes the
        // cached subset so the two may be summed.
        assert_eq!(result.timing.prompt_tokens, 56.0);
        assert_eq!(result.timing.predicted_tokens, 8.0);
        assert_eq!(result.cache_hit_tokens, 64.0);
        assert_eq!(result.slot_id, -1);
        assert_eq!(result.model_id.as_deref(), Some("served-model"));
    }

    #[test]
    fn lifts_reasoning_from_either_spelling() {
        let deepseek = json!({
            "choices": [{"message": {"content": "[]", "reasoning_content": "step one"}}]
        });
        assert_eq!(
            parse_chat_response(&deepseek).unwrap().reasoning_content,
            "step one"
        );

        let openrouter = json!({
            "choices": [{"message": {"content": "[]", "reasoning": "step two"}}]
        });
        assert_eq!(
            parse_chat_response(&openrouter).unwrap().reasoning_content,
            "step two"
        );
    }

    #[test]
    fn truncated_completion_is_reported() {
        let value = json!({
            "choices": [{"message": {"content": "partial"}, "finish_reason": "length"}]
        });
        let result = parse_chat_response(&value).unwrap();
        assert!(result.truncated);
        assert!(!result.stop);
    }

    #[test]
    fn missing_choices_is_an_invalid_response() {
        assert!(matches!(
            parse_chat_response(&json!({"choices": []})),
            Err(LlmClientError::InvalidResponse(_))
        ));
    }

    #[test]
    fn distinguishes_proxy_auth_from_provider_auth() {
        assert!(matches!(
            classify_error(401, "Invalid or missing authorization token", None),
            LlmClientError::Unauthorized {
                origin: AuthErrorSource::LocalServer
            }
        ));
        assert!(matches!(
            classify_error(401, r#"{"error":{"message":"Incorrect API key"}}"#, None),
            LlmClientError::Unauthorized {
                origin: AuthErrorSource::Upstream
            }
        ));
    }

    #[test]
    fn maps_proxy_session_errors_to_session_not_found() {
        assert!(matches!(
            classify_error(404, "No running session found for model 'x'", None),
            LlmClientError::SessionNotFound(_)
        ));
        assert!(matches!(
            classify_error(503, "No models are available", None),
            LlmClientError::SessionNotFound(_)
        ));
    }

    #[test]
    fn rate_limit_carries_retry_after() {
        assert!(matches!(
            classify_error(429, "slow down", Some(7)),
            LlmClientError::RateLimited {
                retry_after_secs: Some(7)
            }
        ));
    }

    #[test]
    fn context_limit_is_its_own_variant() {
        assert!(matches!(
            classify_error(
                400,
                r#"{"error":{"message":"the request exceeds the available context size"}}"#,
                None
            ),
            LlmClientError::ContextOverflow(_)
        ));
    }

    #[test]
    fn schema_rejection_covers_the_speculative_decoding_conflict() {
        assert!(mentions_schema_rejection(
            "Invalid schema for response_format 'atomic_agent_tool_calls'"
        ));
        assert!(mentions_schema_rejection(
            "structured outputs and speculative decoding are mutually exclusive"
        ));
        assert!(mentions_schema_rejection(
            "cannot use guided generation with a draft model"
        ));
        assert!(!mentions_schema_rejection("context window exceeded"));
    }

    #[test]
    fn max_tokens_rename_is_detected() {
        assert!(mentions_max_tokens_rename(
            "Unsupported parameter: 'max_tokens' is not supported; use 'max_completion_tokens'"
        ));
        assert!(!mentions_max_tokens_rename("invalid model"));
    }

    #[test]
    fn vision_payload_only_sends_mlx_knobs_to_mlx() {
        let images = vec![("image/png".to_string(), "AAAA".to_string())];

        let mlx = vision_payload(
            &target(OpenAiTargetKind::LocalMlx, true),
            "describe",
            &images,
        );
        assert_eq!(mlx["chat_template_kwargs"]["enable_thinking"], json!(false));
        assert!(mlx.get("reasoning_format").is_none());
        assert_eq!(
            mlx["messages"][0]["content"][0]["image_url"]["url"],
            json!("data:image/png;base64,AAAA")
        );

        let proxied = vision_payload(
            &target(OpenAiTargetKind::LocalApiServer, false),
            "describe",
            &images,
        );
        assert!(proxied.get("chat_template_kwargs").is_none());
    }

    #[tokio::test]
    async fn context_window_comes_from_the_target_without_a_request() {
        let client = OpenAiCompatibleClient::new(target(OpenAiTargetKind::LocalMlx, true)).unwrap();
        assert_eq!(
            client
                .fetch_context_window(&CancellationToken::new())
                .await
                .unwrap(),
            Some(16_384)
        );
    }

    #[tokio::test]
    async fn model_profile_is_always_plain() {
        let client =
            OpenAiCompatibleClient::new(target(OpenAiTargetKind::LocalApiServer, false)).unwrap();
        assert_eq!(
            client.probe_model_profile(&CancellationToken::new()).await,
            AgentModelProfile::Plain
        );
    }

    #[tokio::test]
    async fn describe_images_refuses_a_text_only_target() {
        let client = OpenAiCompatibleClient::new(target(OpenAiTargetKind::LocalMlx, true)).unwrap();
        let error = client
            .describe_images("describe", &[], &CancellationToken::new())
            .await
            .unwrap_err();
        assert!(matches!(error, LlmClientError::InvalidResponse(_)));
    }
}
