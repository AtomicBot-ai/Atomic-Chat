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
//!
//! Step completions stream by default (`stream: true` + SSE): deltas feed the
//! runner's incremental reply scanner and the accumulated stream is folded
//! back into the exact whole-response shape [`parse_chat_response`] already
//! consumes. Every degrade rung fires before the first delta byte (a non-2xx
//! is classified from the full error body in `send_chat`), so retries never
//! double-emit; targets that reject `stream_options` or streaming entirely
//! set sticky flags and fall back per run. Repair and vision completions stay
//! non-streaming.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

use crate::core::server::context_expansion::is_context_limit_error;
use crate::core::server::request_inspector::extract_reasoning;

use super::llm_client::{
    drain_sse_events, extract_error_detail, model_ids_match, parse_sse_event,
    AgentClientCapabilities, AgentLlmClient, AgentPrompt, AuthErrorSource, CompletionReasoning,
    CompletionRequest, CompletionResult, CompletionTiming, LlmClientError, StreamChunk,
};
use super::model_profile::AgentModelProfile;

const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(600);
const STREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// A stream that stays silent this long is dead — no delta, keep-alive, or
/// usage trailer for two minutes means the server hung, not that it thinks.
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(120);
/// Upper bound on how long a `Retry-After` may park an agent step.
const MAX_RETRY_AFTER: Duration = Duration::from_secs(20);
const TRANSIENT_RETRY_DELAY: Duration = Duration::from_secs(1);
const VISION_MAX_TOKENS: u32 = 1024;
/// How many times one completion may be re-sent while walking the degrade
/// ladder. Six sticky rungs plus the two once-per-completion transient ones
/// bound the real ladder well below this; the cap is a backstop against a
/// target whose 400s keep changing shape.
const MAX_DEGRADE_ATTEMPTS: usize = 10;

/// What to do about one failed attempt. See [`OpenAiCompatibleClient::classify_degrade`].
enum Degrade {
    /// Re-send now — a sticky flag was flipped, so the shape has changed.
    Retry,
    /// Re-send the same shape after `.0` — the target was busy, not wrong.
    RetryAfter(Duration),
    /// Streaming is off for the run; hand the turn to the non-streaming path.
    Unstream,
    /// Nothing left to try; surface the error.
    Fail,
}

/// Once-per-completion guards for the two rungs that re-send an *unchanged*
/// request. Without them the ladder could spin on a target that keeps
/// answering 429 or 503.
#[derive(Default)]
struct TransientBudget {
    rate_limited: bool,
    gateway: bool,
}

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
    /// Streaming requests only: connect timeout but no whole-response budget —
    /// a healthy stream can outlive [`DEFAULT_REQUEST_TIMEOUT`]. Liveness is
    /// enforced per chunk by [`STREAM_IDLE_TIMEOUT`] instead.
    stream_client: reqwest::Client,
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
    /// Set once a target rejects `stream_options`, so usage accounting is
    /// dropped instead of burning one 400 per step.
    stream_usage_disabled: AtomicBool,
    /// Set once a target rejects streaming altogether; every later step goes
    /// straight to the non-streaming path.
    streaming_disabled: AtomicBool,
    /// Set once a target rejects `temperature` or `top_p`. OpenAI's reasoning
    /// models (gpt-5, o-series) accept only the defaults and answer 400 on any
    /// other value, so the run drops both fields and lets the target sample.
    sampling_disabled: AtomicBool,
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
        let stream_client = reqwest::Client::builder()
            .connect_timeout(STREAM_CONNECT_TIMEOUT)
            .no_proxy()
            .build()
            .map_err(|error| LlmClientError::Transport(error.to_string()))?;
        Ok(Self {
            client,
            stream_client,
            target: RwLock::new(target),
            session_reload: None,
            schema_disabled: AtomicBool::new(false),
            use_max_completion_tokens: AtomicBool::new(false),
            reasoning_disabled: AtomicBool::new(false),
            stream_usage_disabled: AtomicBool::new(false),
            streaming_disabled: AtomicBool::new(false),
            sampling_disabled: AtomicBool::new(false),
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

    /// Opens one chat-completions request and classifies every failure that
    /// can be seen before the body streams: connection errors and non-2xx
    /// statuses (whose full error body is read here). On success the caller
    /// owns the response body — whole JSON for `stream: false`, SSE otherwise.
    /// Keeping every classification pre-body is what lets the degrade ladder
    /// retry without ever double-emitting a delta.
    async fn send_chat(
        &self,
        target: &OpenAiTarget,
        payload: &Value,
        stream: bool,
        cancellation: &CancellationToken,
    ) -> Result<reqwest::Response, LlmClientError> {
        let client = if stream {
            &self.stream_client
        } else {
            &self.client
        };
        let accept = if stream {
            "text/event-stream"
        } else {
            "application/json"
        };
        let mut builder = client
            .post(format!("{}/chat/completions", target.base_url))
            .header(CONTENT_TYPE, "application/json")
            .header(ACCEPT, accept)
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
        if status.is_success() {
            return Ok(response);
        }
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
        let body = String::from_utf8_lossy(&bytes);
        Err(classify_error(status.as_u16(), &body, retry_after))
    }

    async fn post_chat(
        &self,
        target: &OpenAiTarget,
        payload: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, LlmClientError> {
        let response = self.send_chat(target, payload, false, cancellation).await?;
        let bytes = tokio::select! {
            _ = cancellation.cancelled() => return Err(LlmClientError::Cancelled),
            result = response.bytes() => {
                result.map_err(|error| LlmClientError::Transport(error.to_string()))?
            }
        };
        serde_json::from_slice(&bytes)
            .map_err(|error| LlmClientError::InvalidResponse(error.to_string()))
    }

    /// Runs one completion, walking the degrade ladder until the target
    /// accepts the request shape.
    ///
    /// Every 400 rung is sticky and strictly narrowing — it drops or renames a
    /// field and never restores it — so successive rejections can chain: a
    /// target that answers `max_tokens` first and `temperature` second (every
    /// OpenAI reasoning model does exactly that) is corrected in one turn
    /// instead of failing on the second 400. The sticky flags also mean the
    /// next step starts from the already-corrected shape.
    async fn complete_with_degrade(
        &self,
        target: &OpenAiTarget,
        request: &CompletionRequest,
        cancellation: &CancellationToken,
    ) -> Result<CompletionResult, LlmClientError> {
        let mut budget = TransientBudget::default();
        let mut attempts = 0;
        loop {
            let payload = self.chat_payload(target, request, false);
            let error = match self.post_chat(target, &payload, cancellation).await {
                Ok(value) => return parse_chat_response(&value),
                Err(error) => error,
            };
            attempts += 1;
            if attempts >= MAX_DEGRADE_ATTEMPTS {
                return Err(error);
            }
            match self.classify_degrade(&error, false, &mut budget) {
                Degrade::Retry => {}
                Degrade::RetryAfter(delay) => sleep_or_cancel(delay, cancellation).await?,
                // `Unstream` is only ever returned for the streaming ladder.
                Degrade::Unstream | Degrade::Fail => return Err(error),
            }
        }
    }

    /// Streaming twin of [`Self::complete_with_degrade`]: the same rungs plus
    /// two stream-specific ones — a target that rejects `stream_options`
    /// retries without usage accounting, and one that rejects streaming
    /// entirely falls back to the non-streaming path, both sticky for the
    /// run. Every rung fires before the first delta byte; a mid-stream error
    /// is never retried because its deltas already reached the UI.
    async fn complete_streaming_with_degrade(
        &self,
        target: &OpenAiTarget,
        request: &CompletionRequest,
        cancellation: &CancellationToken,
        on_chunk: &mut (dyn FnMut(StreamChunk) -> Result<(), String> + Send),
    ) -> Result<CompletionResult, LlmClientError> {
        if self.streaming_disabled.load(Ordering::SeqCst) {
            return self
                .complete_with_degrade(target, request, cancellation)
                .await;
        }
        let mut budget = TransientBudget::default();
        let mut attempts = 0;
        loop {
            let payload = self.chat_payload(target, request, true);
            let error = match self.send_chat(target, &payload, true, cancellation).await {
                Ok(response) => return consume_chat_stream(response, cancellation, on_chunk).await,
                Err(error) => error,
            };
            attempts += 1;
            if attempts >= MAX_DEGRADE_ATTEMPTS {
                return Err(error);
            }
            match self.classify_degrade(&error, true, &mut budget) {
                Degrade::Retry => {}
                Degrade::RetryAfter(delay) => sleep_or_cancel(delay, cancellation).await?,
                Degrade::Unstream => {
                    return self
                        .complete_with_degrade(target, request, cancellation)
                        .await
                }
                Degrade::Fail => return Err(error),
            }
        }
    }

    /// Picks the rung for one failed attempt, flipping the sticky flag it owns.
    ///
    /// Each sticky rung is guarded on its own flag, so a rung fires at most
    /// once per run and the ladder cannot loop on a message it has already
    /// acted on. The two rungs that retry an *unchanged* request — a rate limit
    /// and a transient gateway — are guarded by `budget` instead, once each per
    /// completion.
    fn classify_degrade(
        &self,
        error: &LlmClientError,
        streaming: bool,
        budget: &mut TransientBudget,
    ) -> Degrade {
        let (status, detail) = match error {
            LlmClientError::RateLimited { retry_after_secs } if !budget.rate_limited => {
                budget.rate_limited = true;
                return Degrade::RetryAfter(
                    retry_after_secs
                        .map(Duration::from_secs)
                        .unwrap_or(TRANSIENT_RETRY_DELAY)
                        .min(MAX_RETRY_AFTER),
                );
            }
            LlmClientError::Http { status, detail } => (*status, detail.as_str()),
            _ => return Degrade::Fail,
        };

        if is_transient_gateway(status) {
            if budget.gateway {
                return Degrade::Fail;
            }
            budget.gateway = true;
            log::warn!("Retrying agent completion after HTTP {status}: {detail}");
            return Degrade::RetryAfter(TRANSIENT_RETRY_DELAY);
        }
        if status != 400 {
            return Degrade::Fail;
        }

        if mentions_schema_rejection(detail) && !self.schema_disabled.load(Ordering::SeqCst) {
            log::info!(
                "Disabling response_format for this run: the model server rejected the \
                 tool-call schema ({detail})"
            );
            self.schema_disabled.store(true, Ordering::SeqCst);
            return Degrade::Retry;
        }
        if mentions_reasoning_rejection(detail) && !self.reasoning_disabled.load(Ordering::SeqCst) {
            log::info!(
                "Dropping the reasoning fields for this run: the model server rejected \
                 them ({detail})"
            );
            self.reasoning_disabled.store(true, Ordering::SeqCst);
            return Degrade::Retry;
        }
        if mentions_max_tokens_rename(detail)
            && !self.use_max_completion_tokens.load(Ordering::SeqCst)
        {
            log::info!(
                "Switching to max_completion_tokens for this run: the model server rejected \
                 max_tokens ({detail})"
            );
            self.use_max_completion_tokens.store(true, Ordering::SeqCst);
            return Degrade::Retry;
        }
        if mentions_sampling_rejection(detail) && !self.sampling_disabled.load(Ordering::SeqCst) {
            log::info!(
                "Dropping temperature and top_p for this run: the model server accepts only \
                 its own defaults ({detail})"
            );
            self.sampling_disabled.store(true, Ordering::SeqCst);
            return Degrade::Retry;
        }
        if !streaming {
            return Degrade::Fail;
        }
        // Checked before the plain stream rejection: "stream_options"
        // contains "stream", so the narrower matcher must win.
        if mentions_stream_options_rejection(detail)
            && !self.stream_usage_disabled.load(Ordering::SeqCst)
        {
            log::info!(
                "Dropping stream_options for this run: the model server rejected it ({detail})"
            );
            self.stream_usage_disabled.store(true, Ordering::SeqCst);
            return Degrade::Retry;
        }
        if mentions_stream_rejection(detail) && !self.streaming_disabled.load(Ordering::SeqCst) {
            log::info!("Disabling streaming for this run: the model server rejected it ({detail})");
            self.streaming_disabled.store(true, Ordering::SeqCst);
            return Degrade::Unstream;
        }
        Degrade::Fail
    }

    fn chat_payload(
        &self,
        target: &OpenAiTarget,
        request: &CompletionRequest,
        stream: bool,
    ) -> Value {
        let mut body = Map::new();
        body.insert("model".into(), json!(target.model_id));
        body.insert("messages".into(), json!(prompt_messages(&request.prompt)));
        body.insert("stream".into(), json!(stream));
        if stream && !self.stream_usage_disabled.load(Ordering::SeqCst) {
            // Opt-in usage on streams: mlx >= 0.6.0 only reports usage when
            // asked, and cloud targets need it for cached-token accounting.
            // Servers that reject the field trip the sticky degrade rung.
            body.insert("stream_options".into(), json!({"include_usage": true}));
        }
        // OpenAI's reasoning models pin both to their defaults and answer 400
        // on any other value, so the sampling rung drops them for the run and
        // lets the target sample on its own terms.
        if !self.sampling_disabled.load(Ordering::SeqCst) {
            body.insert("temperature".into(), json!(request.temperature));
            body.insert("top_p".into(), json!(request.top_p));
        }
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

    async fn complete_streaming(
        &self,
        request: &CompletionRequest,
        cancellation: &CancellationToken,
        on_chunk: &mut (dyn FnMut(StreamChunk) -> Result<(), String> + Send),
    ) -> Result<CompletionResult, LlmClientError> {
        let target = self.target();
        match self
            .complete_streaming_with_degrade(&target, request, cancellation, on_chunk)
            .await
        {
            // Verbatim twin of the wrapper in `complete`: a context overflow
            // is classified before any delta byte, so the retry after a
            // reload cannot double-emit.
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
                self.complete_streaming_with_degrade(&replacement, request, cancellation, on_chunk)
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
        // The same ladder as the chat path: the vision tool is often the first
        // request of a run, so it cannot assume a sibling completion has
        // already taught the client which fields this target refuses.
        let mut budget = TransientBudget::default();
        let mut attempts = 0;
        let value = loop {
            let payload = vision_payload(
                &target,
                prompt,
                images,
                self.sampling_disabled.load(Ordering::SeqCst),
                self.use_max_completion_tokens.load(Ordering::SeqCst),
            );
            let error = match self.post_chat(&target, &payload, cancellation).await {
                Ok(value) => break value,
                Err(error) => error,
            };
            attempts += 1;
            if attempts >= MAX_DEGRADE_ATTEMPTS {
                return Err(error);
            }
            match self.classify_degrade(&error, false, &mut budget) {
                Degrade::Retry => {}
                Degrade::RetryAfter(delay) => sleep_or_cancel(delay, cancellation).await?,
                Degrade::Unstream | Degrade::Fail => return Err(error),
            }
        };
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

/// Builds the vision request.
///
/// `drop_sampling` and `use_max_completion_tokens` are the two sticky degrade
/// flags, threaded in so a target that has already rejected a field on the chat
/// path is not asked to reject it again here.
fn vision_payload(
    target: &OpenAiTarget,
    prompt: &str,
    images: &[(String, String)],
    drop_sampling: bool,
    use_max_completion_tokens: bool,
) -> Value {
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
    let token_key = if use_max_completion_tokens {
        "max_completion_tokens"
    } else {
        "max_tokens"
    };
    body.insert(token_key.into(), json!(VISION_MAX_TOKENS));
    if !drop_sampling {
        body.insert("temperature".into(), json!(0.2));
    }
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

/// Folds a chat-completions SSE stream back into the whole-response shape.
///
/// Deltas are concatenated; `finish_reason`, `usage`, `timings`, and `model`
/// are read off whatever chunk carries them — mlx packs finish, usage, and
/// timings into one final chunk, OpenAI sends a separate usage trailer with
/// an empty `choices` array, and content chunks carry `"usage": null`. The
/// synthesized response goes through [`parse_chat_response`] so cached-token
/// normalization stays single-source.
#[derive(Default)]
struct ChatStreamAccumulator {
    content: String,
    reasoning: String,
    finish_reason: Option<String>,
    usage: Option<Value>,
    timings: Option<Value>,
    model: Option<String>,
    saw_choice: bool,
}

impl ChatStreamAccumulator {
    /// Ingests one SSE payload; returns a chunk to forward when it carried
    /// visible text (a role-only delta or a bare trailer returns `None`).
    fn ingest(&mut self, value: &Value) -> Option<StreamChunk> {
        if self.model.is_none() {
            if let Some(model) = value.get("model").and_then(Value::as_str) {
                self.model = Some(model.to_owned());
            }
        }
        if let Some(usage) = value.get("usage").filter(|usage| !usage.is_null()) {
            self.usage = Some(usage.clone());
        }
        if let Some(timings) = value.get("timings").filter(|timings| !timings.is_null()) {
            self.timings = Some(timings.clone());
        }
        let choice = value.pointer("/choices/0")?;
        self.saw_choice = true;
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.finish_reason = Some(reason.to_owned());
        }
        let delta = choice
            .pointer("/delta/content")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let reasoning_delta = extract_reasoning(choice).unwrap_or_default();
        if delta.is_empty() && reasoning_delta.is_empty() {
            return None;
        }
        self.content.push_str(&delta);
        self.reasoning.push_str(&reasoning_delta);
        Some(StreamChunk {
            delta,
            reasoning_delta,
            done: false,
        })
    }

    fn into_result(self) -> Result<CompletionResult, LlmClientError> {
        if !self.saw_choice {
            return Err(LlmClientError::InvalidResponse(
                "stream ended without any choices".into(),
            ));
        }
        let timings = self.timings.clone();
        let response = json!({
            "model": self.model,
            "choices": [{
                "message": {
                    "content": self.content,
                    "reasoning_content": self.reasoning,
                },
                "finish_reason": self.finish_reason,
            }],
            "usage": self.usage,
        });
        let mut result = parse_chat_response(&response)?;
        apply_stream_timings(&mut result, timings.as_ref());
        Ok(result)
    }
}

/// mlx streams llama-shaped `timings`; recover the wall-clock split so tps
/// matches what the non-streaming path would have reported.
fn apply_stream_timings(result: &mut CompletionResult, timings: Option<&Value>) {
    let Some(timings) = timings else { return };
    let number = |key: &str| timings.get(key).and_then(Value::as_f64);
    if let Some(prompt_ms) = number("prompt_ms") {
        result.timing.prompt_ms = prompt_ms;
    }
    if let Some(predicted_ms) = number("predicted_ms") {
        result.timing.predicted_ms = predicted_ms;
    } else if let (Some(predicted_n), Some(rate)) =
        (number("predicted_n"), number("predicted_per_second"))
    {
        if rate > 0.0 {
            result.timing.predicted_ms = predicted_n / rate * 1000.0;
        }
    }
}

/// Reads an open SSE response to completion, forwarding visible deltas. The
/// idle timeout bounds each chunk gap; the shared line-splitting helpers are
/// the llama transport's, so chunk-boundary and CRLF handling stay identical.
async fn consume_chat_stream(
    response: reqwest::Response,
    cancellation: &CancellationToken,
    on_chunk: &mut (dyn FnMut(StreamChunk) -> Result<(), String> + Send),
) -> Result<CompletionResult, LlmClientError> {
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut pending_utf8: Vec<u8> = Vec::new();
    let mut accumulator = ChatStreamAccumulator::default();

    loop {
        let next = tokio::select! {
            _ = cancellation.cancelled() => return Err(LlmClientError::Cancelled),
            item = tokio::time::timeout(STREAM_IDLE_TIMEOUT, stream.next()) => match item {
                Ok(item) => item,
                Err(_) => return Err(LlmClientError::TimedOut),
            },
        };
        let Some(bytes) = next else {
            break;
        };
        let bytes = bytes.map_err(|error| LlmClientError::Transport(error.to_string()))?;
        pending_utf8.extend_from_slice(&bytes);
        match std::str::from_utf8(&pending_utf8) {
            Ok(text) => {
                buffer.push_str(text);
                pending_utf8.clear();
            }
            Err(error) if error.error_len().is_none() => continue,
            Err(error) => {
                return Err(LlmClientError::InvalidResponse(error.to_string()));
            }
        }
        for event in drain_sse_events(&mut buffer) {
            // `[DONE]` parses to None like every non-data line; the stream
            // closing right after is what actually ends the loop.
            let Some(payload) = parse_sse_event(&event) else {
                continue;
            };
            if let Some(chunk) = accumulator.ingest(&payload) {
                on_chunk(chunk).map_err(LlmClientError::StreamConsumer)?;
            }
        }
    }
    if !pending_utf8.is_empty() {
        return Err(LlmClientError::InvalidResponse(
            "stream ended inside a UTF-8 code point".into(),
        ));
    }

    let result = accumulator.into_result()?;
    on_chunk(StreamChunk {
        delta: String::new(),
        reasoning_delta: String::new(),
        done: true,
    })
    .map_err(LlmClientError::StreamConsumer)?;
    Ok(result)
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
    // The shared inspector helper covers every wild spelling —
    // `reasoning_content` (DeepSeek / mlx-vlm), `reasoning` (OpenRouter,
    // Ollama), and `reasoning_details` (OpenRouter's parts list). Inline
    // `<think>` blocks need no handling here — the shared parser strips them.
    let reasoning_content = value
        .pointer("/choices/0")
        .and_then(extract_reasoning)
        .unwrap_or_default();
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

/// Whether a 400 blames `temperature` or `top_p`.
///
/// OpenAI's reasoning models pin both to their defaults and reject anything
/// else — "Unsupported value: 'temperature' does not support 0.2 with this
/// model" — one field per response, so the rung drops both at once rather than
/// paying a second round trip for `top_p` after `temperature` is gone. A
/// rejection verb is required because both names appear in unrelated messages.
fn mentions_sampling_rejection(detail: &str) -> bool {
    let lowered = detail.to_ascii_lowercase();
    if !["temperature", "top_p"]
        .iter()
        .any(|needle| lowered.contains(needle))
    {
        return false;
    }
    [
        // OpenAI reasoning models: "Unsupported value: 'temperature' does not
        // support 0.2 with this model. Only the default (1) value is
        // supported." / "Unsupported parameter: 'top_p' is not supported".
        "unsupported",
        "not supported",
        "not support",
        "invalid",
        // Anthropic, Claude 4.1 and newer: "`temperature` and `top_p` cannot
        // both be specified for this model. Please use only one." Nothing in
        // that sentence matches the OpenAI wording above, so it needs its own
        // needles — dropping both fields satisfies it either way.
        "cannot both",
        "only one",
        "cannot be",
        "must be",
        // Anthropic again, for models released after Claude Opus 4.6 (the
        // reference marks both fields Deprecated): "temperature is deprecated
        // for this model." Only the default is accepted, so dropping the field
        // is the whole fix.
        "deprecated",
    ]
    .iter()
    .any(|needle| lowered.contains(needle))
}

/// Whether a 400 blames `stream_options`. Checked before
/// [`mentions_stream_rejection`] — the field name contains "stream".
fn mentions_stream_options_rejection(detail: &str) -> bool {
    detail.to_ascii_lowercase().contains("stream_options")
}

/// Whether a 400 says the target cannot stream at all. Deliberately narrow:
/// "stream" alone appears in unrelated messages, so a rejection verb must
/// accompany it, and `stream_options` complaints are excluded.
fn mentions_stream_rejection(detail: &str) -> bool {
    let lowered = detail.to_ascii_lowercase();
    if lowered.contains("stream_options") {
        return false;
    }
    lowered.contains("stream")
        && ["unsupported", "not supported", "not support", "invalid"]
            .iter()
            .any(|needle| lowered.contains(needle))
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
        let payload = client.chat_payload(&client.target(), &request_with_schema(), false);

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
        let payload = client.chat_payload(&client.target(), &request, false);

        assert_eq!(payload["messages"].as_array().unwrap().len(), 1);
        assert_eq!(payload["messages"][0]["role"], json!("user"));
        assert_eq!(payload["messages"][0]["content"], json!("flat prompt"));
    }

    #[test]
    fn response_format_follows_the_target_and_the_degrade_flag() {
        let capable =
            OpenAiCompatibleClient::new(target(OpenAiTargetKind::LocalMlx, true)).unwrap();
        let payload = capable.chat_payload(&capable.target(), &request_with_schema(), false);
        assert_eq!(
            payload["response_format"]["json_schema"]["name"],
            json!("atomic_agent_tool_calls")
        );

        capable.schema_disabled.store(true, Ordering::SeqCst);
        let degraded = capable.chat_payload(&capable.target(), &request_with_schema(), false);
        assert!(degraded.get("response_format").is_none());

        let incapable =
            OpenAiCompatibleClient::new(target(OpenAiTargetKind::LocalApiServer, false)).unwrap();
        let payload = incapable.chat_payload(&incapable.target(), &request_with_schema(), false);
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
            false,
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
            false,
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
            false,
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
            let payload =
                client.chat_payload(&client.target(), &request_with_reasoning(reasoning), false);

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
            .chat_payload(&client.target(), &request, false)
            .get("reasoning_effort")
            .is_some());

        client.reasoning_disabled.store(true, Ordering::SeqCst);

        assert!(client
            .chat_payload(&client.target(), &request, false)
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
    fn sampling_rejection_is_detected() {
        // Verbatim from api.openai.com for gpt-5-mini.
        assert!(mentions_sampling_rejection(
            "Unsupported value: 'temperature' does not support 0.2 with this model. \
             Only the default (1) value is supported."
        ));
        assert!(mentions_sampling_rejection(
            "Unsupported parameter: 'top_p' is not supported with this model."
        ));
        // Verbatim from api.anthropic.com for claude-sonnet-4-5 and every
        // Claude 4.1+ model: the wording shares no vocabulary with OpenAI's.
        assert!(mentions_sampling_rejection(
            "`temperature` and `top_p` cannot both be specified for this model. \
             Please use only one."
        ));
        // Verbatim from api.anthropic.com for claude-opus-4-7 and newer, whose
        // reference marks both fields Deprecated. Shares no vocabulary with
        // either of the wordings above.
        assert!(mentions_sampling_rejection(
            "temperature is deprecated for this model."
        ));
        assert!(mentions_sampling_rejection(
            "top_p is deprecated for this model."
        ));
        // A rejection verb is required: both names appear in healthy prose.
        assert!(!mentions_sampling_rejection("temperature 0.2, top_p 0.95"));
        assert!(!mentions_sampling_rejection("invalid model"));
        // ...and a sampler name is required, so unrelated 400s stay untouched.
        assert!(!mentions_sampling_rejection(
            "messages: at least one message is required"
        ));
        assert!(!mentions_sampling_rejection(
            "max_tokens must be greater than 0"
        ));
    }

    /// The Anthropic shape end to end: one 400 naming both samplers, one rung,
    /// and a retry that sends neither.
    #[test]
    fn anthropic_temperature_top_p_conflict_is_recovered() {
        let client =
            OpenAiCompatibleClient::new(target(OpenAiTargetKind::LocalApiServer, false)).unwrap();
        let conflict = LlmClientError::Http {
            status: 400,
            detail: "`temperature` and `top_p` cannot both be specified for this model. \
                     Please use only one."
                .into(),
        };

        assert!(matches!(
            client.classify_degrade(&conflict, true, &mut TransientBudget::default()),
            Degrade::Retry
        ));

        let payload = client.chat_payload(&client.target(), &request_with_schema(), true);
        assert!(payload.get("temperature").is_none());
        assert!(payload.get("top_p").is_none());
        // Anthropic's compat endpoint takes max_tokens as-is, so the rename
        // rung must stay unfired here.
        assert_eq!(payload["max_tokens"], json!(8_192));
    }

    #[test]
    fn payload_drops_sampling_after_a_rejection() {
        let client =
            OpenAiCompatibleClient::new(target(OpenAiTargetKind::LocalApiServer, false)).unwrap();
        let payload = client.chat_payload(&client.target(), &request_with_schema(), false);
        assert!(payload.get("temperature").is_some());
        assert!(payload.get("top_p").is_some());

        client.sampling_disabled.store(true, Ordering::SeqCst);
        let payload = client.chat_payload(&client.target(), &request_with_schema(), false);
        assert!(payload.get("temperature").is_none());
        assert!(payload.get("top_p").is_none());
    }

    /// The shape every OpenAI reasoning model forces: `max_tokens` is rejected
    /// first, then `temperature` on the corrected retry. One rung per
    /// completion used to leave the second 400 unhandled, which surfaced as an
    /// empty reply.
    #[test]
    fn degrade_ladder_chains_rungs_within_one_completion() {
        let client =
            OpenAiCompatibleClient::new(target(OpenAiTargetKind::LocalApiServer, false)).unwrap();
        let mut budget = TransientBudget::default();

        let rename = LlmClientError::Http {
            status: 400,
            detail: "Unsupported parameter: 'max_tokens' is not supported with this model. \
                     Use 'max_completion_tokens' instead."
                .into(),
        };
        assert!(matches!(
            client.classify_degrade(&rename, true, &mut budget),
            Degrade::Retry
        ));
        // A rung that already fired cannot fire again, so the loop terminates.
        assert!(matches!(
            client.classify_degrade(&rename, true, &mut budget),
            Degrade::Fail
        ));

        let temperature = LlmClientError::Http {
            status: 400,
            detail: "Unsupported value: 'temperature' does not support 0.2 with this model.".into(),
        };
        assert!(matches!(
            client.classify_degrade(&temperature, true, &mut budget),
            Degrade::Retry
        ));

        let payload = client.chat_payload(&client.target(), &request_with_schema(), true);
        assert_eq!(payload["max_completion_tokens"], json!(8_192));
        assert!(payload.get("max_tokens").is_none());
        assert!(payload.get("temperature").is_none());
        assert!(payload.get("top_p").is_none());
    }

    #[test]
    fn transient_rungs_retry_once_each_then_give_up() {
        let client =
            OpenAiCompatibleClient::new(target(OpenAiTargetKind::LocalApiServer, false)).unwrap();
        let mut budget = TransientBudget::default();

        let limited = LlmClientError::RateLimited {
            retry_after_secs: Some(3),
        };
        assert!(matches!(
            client.classify_degrade(&limited, false, &mut budget),
            Degrade::RetryAfter(delay) if delay == Duration::from_secs(3)
        ));
        assert!(matches!(
            client.classify_degrade(&limited, false, &mut budget),
            Degrade::Fail
        ));

        let gateway = LlmClientError::Http {
            status: 503,
            detail: "upstream unavailable".into(),
        };
        assert!(matches!(
            client.classify_degrade(&gateway, false, &mut budget),
            Degrade::RetryAfter(_)
        ));
        assert!(matches!(
            client.classify_degrade(&gateway, false, &mut budget),
            Degrade::Fail
        ));
    }

    #[test]
    fn stream_rungs_are_streaming_only() {
        let client =
            OpenAiCompatibleClient::new(target(OpenAiTargetKind::LocalApiServer, false)).unwrap();
        let rejected = LlmClientError::Http {
            status: 400,
            detail: "stream is not supported with this model".into(),
        };
        assert!(matches!(
            client.classify_degrade(&rejected, false, &mut TransientBudget::default()),
            Degrade::Fail
        ));
        assert!(matches!(
            client.classify_degrade(&rejected, true, &mut TransientBudget::default()),
            Degrade::Unstream
        ));
    }

    #[test]
    fn max_tokens_key_switches_after_a_rename_rejection() {
        let client =
            OpenAiCompatibleClient::new(target(OpenAiTargetKind::LocalApiServer, false)).unwrap();
        client
            .use_max_completion_tokens
            .store(true, Ordering::SeqCst);
        let payload = client.chat_payload(&client.target(), &request_with_schema(), false);

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
            false,
            false,
        );
        assert_eq!(mlx["chat_template_kwargs"]["enable_thinking"], json!(false));
        assert!(mlx.get("reasoning_format").is_none());
        assert_eq!(
            mlx["messages"][0]["content"][0]["image_url"]["url"],
            json!("data:image/png;base64,AAAA")
        );
        assert_eq!(mlx["temperature"], json!(0.2));
        assert_eq!(mlx["max_tokens"], json!(VISION_MAX_TOKENS));

        let proxied = vision_payload(
            &target(OpenAiTargetKind::LocalApiServer, false),
            "describe",
            &images,
            false,
            false,
        );
        assert!(proxied.get("chat_template_kwargs").is_none());
    }

    /// The vision tool used to build its payload by hand and post it straight
    /// past the ladder, so a target that refuses `temperature` (Claude Opus 4.7
    /// and newer, every OpenAI reasoning model) failed the image tool even
    /// after the chat path had learned better.
    #[test]
    fn vision_payload_honours_the_degrade_flags() {
        let images = vec![("image/png".to_string(), "AAAA".to_string())];
        let degraded = vision_payload(
            &target(OpenAiTargetKind::LocalApiServer, false),
            "describe",
            &images,
            true,
            true,
        );

        assert!(degraded.get("temperature").is_none());
        assert!(degraded.get("max_tokens").is_none());
        assert_eq!(degraded["max_completion_tokens"], json!(VISION_MAX_TOKENS));
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

    fn delta_chunk(delta: Value) -> Value {
        json!({
            "model": "chunk-model",
            "choices": [{"index": 0, "delta": delta, "finish_reason": null}],
            "usage": null,
        })
    }

    #[test]
    fn accumulator_concatenates_deltas_and_reads_the_usage_trailer() {
        let mut accumulator = ChatStreamAccumulator::default();
        // Role-only delta: recorded as a choice but nothing to forward.
        assert!(accumulator
            .ingest(&delta_chunk(json!({"role": "assistant"})))
            .is_none());
        let first = accumulator
            .ingest(&delta_chunk(json!({"content": "hel"})))
            .expect("first content chunk");
        assert_eq!(first.delta, "hel");
        assert!(!first.done);
        accumulator
            .ingest(&delta_chunk(json!({"content": "lo"})))
            .expect("second content chunk");
        // Finish chunk with a null usage — the null must not clobber anything.
        assert!(accumulator
            .ingest(&json!({
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                "usage": null,
            }))
            .is_none());
        // OpenAI usage trailer: empty choices array, usage only.
        assert!(accumulator
            .ingest(&json!({
                "choices": [],
                "usage": {
                    "prompt_tokens": 100,
                    "completion_tokens": 7,
                    "prompt_tokens_details": {"cached_tokens": 60},
                },
            }))
            .is_none());
        let result = accumulator.into_result().expect("stream result");
        assert_eq!(result.content, "hello");
        assert!(result.stop);
        assert!(!result.truncated);
        // Cached-token normalization flows through `parse_chat_response`.
        assert_eq!(result.timing.prompt_tokens, 40.0);
        assert_eq!(result.cache_hit_tokens, 60.0);
        assert_eq!(result.timing.predicted_tokens, 7.0);
        assert_eq!(result.model_id.as_deref(), Some("chunk-model"));
    }

    #[test]
    fn accumulator_lifts_every_reasoning_spelling() {
        for delta in [
            json!({"reasoning_content": "thinking"}),
            json!({"reasoning": "thinking"}),
            json!({"reasoning_details": [{"text": "think"}, {"text": "ing"}]}),
        ] {
            let mut accumulator = ChatStreamAccumulator::default();
            let chunk = accumulator
                .ingest(&delta_chunk(delta.clone()))
                .unwrap_or_else(|| panic!("reasoning chunk for {delta}"));
            assert_eq!(chunk.reasoning_delta, "thinking");
            assert!(chunk.delta.is_empty());
        }
    }

    #[test]
    fn accumulator_reads_the_mlx_combined_final_chunk() {
        // mlx packs finish_reason, usage, and llama-shaped timings into the
        // one final chunk instead of a separate trailer.
        let mut accumulator = ChatStreamAccumulator::default();
        accumulator
            .ingest(&delta_chunk(json!({"content": "done"})))
            .expect("content chunk");
        assert!(accumulator
            .ingest(&json!({
                "model": "mlx-model",
                "choices": [{"index": 0, "delta": {}, "finish_reason": "length"}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 40},
                "timings": {"prompt_ms": 12.5, "predicted_n": 40, "predicted_per_second": 80.0},
            }))
            .is_none());
        let result = accumulator.into_result().expect("stream result");
        assert!(result.truncated);
        assert_eq!(result.timing.prompt_ms, 12.5);
        // 40 tokens at 80 tok/s = 500ms, recovered for tps parity.
        assert_eq!(result.timing.predicted_ms, 500.0);
        assert_eq!(result.timing.predicted_tokens, 40.0);
    }

    #[test]
    fn accumulator_rejects_a_stream_without_choices() {
        let mut accumulator = ChatStreamAccumulator::default();
        assert!(accumulator
            .ingest(&json!({"choices": [], "usage": {"prompt_tokens": 1}}))
            .is_none());
        assert!(matches!(
            accumulator.into_result(),
            Err(LlmClientError::InvalidResponse(_))
        ));
    }

    #[test]
    fn parse_chat_response_reads_reasoning_details_parts() {
        let value = json!({
            "choices": [{
                "message": {
                    "content": "answer",
                    "reasoning_details": [{"text": "step one"}, {"text": ", step two"}],
                },
                "finish_reason": "stop",
            }],
        });
        let result = parse_chat_response(&value).expect("parse");
        assert_eq!(result.reasoning_content, "step one, step two");
    }

    #[test]
    fn stream_rejection_matchers_stay_disjoint_and_narrow() {
        assert!(mentions_stream_options_rejection(
            "Unrecognized request argument supplied: stream_options"
        ));
        assert!(!mentions_stream_rejection(
            "Unrecognized request argument supplied: stream_options"
        ));
        assert!(mentions_stream_rejection(
            "stream mode is not supported for this model"
        ));
        assert!(mentions_stream_rejection("Invalid value for 'stream'"));
        // "stream" alone, without a rejection verb, must not trip the rung.
        assert!(!mentions_stream_rejection(
            "the stream ended before completion"
        ));
        assert!(!mentions_stream_options_rejection("bad request"));
    }
}
