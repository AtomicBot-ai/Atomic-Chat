//! Direct HTTP client to the local `llama-server` `/completion` endpoint.

use std::sync::{Arc, RwLock};
use std::time::Duration;

use async_trait::async_trait;
use futures_util::StreamExt;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri_plugin_llamacpp::state::LlamacppState;
use tauri_plugin_llamacpp_upstream::state::LlamacppState as LlamacppUpstreamState;
use thiserror::Error;
use tokio_util::sync::CancellationToken;

use crate::core::server::context_expansion::is_context_limit_error;

use super::model_profile::AgentModelProfile;
use super::token_budget::COMPLETION_MAX_TOKENS;
use super::types::ToolCallPayload;

const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(600);
const ERROR_DETAIL_MAX_LEN: usize = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LlamaBackend {
    Llamacpp,
    LlamacppUpstream,
}

impl LlamaBackend {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Llamacpp => "llamacpp",
            Self::LlamacppUpstream => "llamacpp-upstream",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LlamaSessionTarget {
    pub port: i32,
    pub api_key: String,
    pub model_id: String,
    pub has_vision: bool,
    pub backend: LlamaBackend,
}

#[async_trait]
pub trait ContextExpansionHook: Send + Sync {
    async fn expand(
        &self,
        target: &LlamaSessionTarget,
        cancellation: &CancellationToken,
    ) -> Result<LlamaSessionTarget, String>;
}

#[derive(Debug, Clone)]
pub struct CompletionRequest {
    pub prompt: String,
    pub grammar: Option<String>,
    pub slot_id: Option<i32>,
    pub max_tokens: u32,
    pub temperature: f32,
    pub top_p: f32,
    pub top_k: i32,
    pub repeat_penalty: f32,
    pub repeat_last_n: i32,
    pub stop: Vec<String>,
}

impl CompletionRequest {
    pub fn tool_call(prompt: impl Into<String>, grammar: impl Into<String>, slot_id: i32) -> Self {
        Self {
            prompt: prompt.into(),
            grammar: Some(grammar.into()),
            slot_id: Some(slot_id),
            max_tokens: COMPLETION_MAX_TOKENS,
            temperature: 0.2,
            top_p: 0.95,
            top_k: 40,
            repeat_penalty: 1.1,
            repeat_last_n: 256,
            stop: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct CompletionTiming {
    pub prompt_ms: f64,
    pub predicted_ms: f64,
    pub prompt_tokens: f64,
    pub predicted_tokens: f64,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct CompletionResult {
    pub content: String,
    pub reasoning_content: String,
    pub stop: bool,
    pub truncated: bool,
    pub timing: CompletionTiming,
    pub cache_hit_tokens: f64,
    pub slot_id: i32,
    pub model_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamChunk {
    pub delta: String,
    pub reasoning_delta: String,
    pub done: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedToolCalls {
    pub calls: Vec<ToolCallPayload>,
    pub reasoning: Option<String>,
}

#[derive(Debug, Error)]
pub enum LlamaClientError {
    #[error("no active llama.cpp session for model '{0}'")]
    SessionNotFound(String),
    #[error("llama-server request was cancelled")]
    Cancelled,
    #[error("llama-server completion exceeded the 600-second deadline")]
    TimedOut,
    #[error("llama-server returned HTTP {status}: {detail}")]
    Http { status: u16, detail: String },
    #[error("llama-server transport error: {0}")]
    Transport(String),
    #[error("invalid llama-server response: {0}")]
    InvalidResponse(String),
    #[error("invalid tool-call completion: {0}")]
    ToolCallParse(String),
    #[error("stream consumer failed: {0}")]
    StreamConsumer(String),
}

#[derive(Debug, Serialize)]
struct CompletionPayload<'a> {
    prompt: &'a str,
    stream: bool,
    cache_prompt: bool,
    temperature: f32,
    top_p: f32,
    top_k: i32,
    n_predict: u32,
    repeat_penalty: f32,
    repeat_last_n: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    grammar: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stop: Option<&'a [String]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    slot_id: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    id_slot: Option<i32>,
}

#[derive(Debug, Deserialize)]
struct CompletionEnvelope {
    #[serde(default)]
    content: String,
    #[serde(default)]
    reasoning_content: String,
    #[serde(default)]
    stop: bool,
    #[serde(default)]
    truncated: bool,
    #[serde(default)]
    timings: Value,
    #[serde(default)]
    tokens_evaluated: Value,
    #[serde(default)]
    tokens_predicted: Value,
    #[serde(default)]
    tokens_cached: Value,
    #[serde(default)]
    slot_id: Value,
    #[serde(default)]
    id_slot: Value,
    #[serde(default)]
    model: Option<String>,
}

pub struct LlamaServerClient {
    client: reqwest::Client,
    target: RwLock<LlamaSessionTarget>,
    context_expansion: Option<Arc<dyn ContextExpansionHook>>,
}

impl LlamaServerClient {
    pub fn new(target: &LlamaSessionTarget) -> Result<Self, LlamaClientError> {
        let client = reqwest::Client::builder()
            .timeout(DEFAULT_REQUEST_TIMEOUT)
            .build()
            .map_err(|error| LlamaClientError::Transport(error.to_string()))?;
        Ok(Self {
            client,
            target: RwLock::new(target.clone()),
            context_expansion: None,
        })
    }

    pub fn with_context_expansion(mut self, hook: Arc<dyn ContextExpansionHook>) -> Self {
        self.context_expansion = Some(hook);
        self
    }

    pub fn retarget(&self, target: &LlamaSessionTarget) {
        *self.target.write().expect("llama target lock poisoned") = target.clone();
    }

    pub fn target(&self) -> LlamaSessionTarget {
        self.target
            .read()
            .expect("llama target lock poisoned")
            .clone()
    }

    pub async fn fetch_context_window(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<Option<usize>, LlamaClientError> {
        let props = self.fetch_props(cancellation).await?;
        Ok(read_context_window(&props))
    }

    pub async fn fetch_props(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<Value, LlamaClientError> {
        let target = self.target();
        let mut request = self
            .client
            .get(format!("http://127.0.0.1:{}/props", target.port));
        if !target.api_key.is_empty() {
            request = request.header(AUTHORIZATION, format!("Bearer {}", target.api_key));
        }
        let response = tokio::select! {
            _ = cancellation.cancelled() => return Err(LlamaClientError::Cancelled),
            result = request.send() => {
                result.map_err(|error| LlamaClientError::Transport(error.to_string()))?
            }
        };
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| LlamaClientError::Transport(error.to_string()))?;
        if !status.is_success() {
            return Err(LlamaClientError::Http {
                status: status.as_u16(),
                detail: extract_error_detail(&String::from_utf8_lossy(&bytes)),
            });
        }
        serde_json::from_slice(&bytes)
            .map_err(|error| LlamaClientError::InvalidResponse(error.to_string()))
    }

    pub async fn describe_images(
        &self,
        prompt: &str,
        images: &[(String, String)],
        cancellation: &CancellationToken,
    ) -> Result<String, LlamaClientError> {
        let target = self.target();
        if !target.has_vision {
            return Err(LlamaClientError::InvalidResponse(
                "active llama.cpp session is not vision-capable".into(),
            ));
        }
        let payload = vision_request_payload(&target.model_id, prompt, images);
        let mut request = self
            .client
            .post(format!(
                "http://127.0.0.1:{}/v1/chat/completions",
                target.port
            ))
            .header(ACCEPT, "application/json")
            .header(CONTENT_TYPE, "application/json")
            .json(&payload);
        if !target.api_key.is_empty() {
            request = request.header(AUTHORIZATION, format!("Bearer {}", target.api_key));
        }
        let response = tokio::select! {
            _ = cancellation.cancelled() => return Err(LlamaClientError::Cancelled),
            result = request.send() => {
                result.map_err(|error| LlamaClientError::Transport(error.to_string()))?
            }
        };
        let status = response.status();
        let bytes = tokio::select! {
            _ = cancellation.cancelled() => return Err(LlamaClientError::Cancelled),
            result = response.bytes() => {
                result.map_err(|error| LlamaClientError::Transport(error.to_string()))?
            }
        };
        if !status.is_success() {
            return Err(LlamaClientError::Http {
                status: status.as_u16(),
                detail: extract_error_detail(&String::from_utf8_lossy(&bytes)),
            });
        }
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|error| LlamaClientError::InvalidResponse(error.to_string()))?;
        value
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_owned)
            .ok_or_else(|| {
                LlamaClientError::InvalidResponse(
                    "vision response did not contain message content".into(),
                )
            })
    }

    pub async fn complete(
        &self,
        request: &CompletionRequest,
        cancellation: &CancellationToken,
    ) -> Result<CompletionResult, LlamaClientError> {
        let response = self.send(request, false, cancellation).await?;
        let payload = tokio::select! {
            _ = cancellation.cancelled() => return Err(LlamaClientError::Cancelled),
            result = response.json::<CompletionEnvelope>() => {
                result.map_err(|error| LlamaClientError::InvalidResponse(error.to_string()))?
            }
        };
        Ok(normalize_completion(payload))
    }

    pub async fn complete_stream<F>(
        &self,
        request: &CompletionRequest,
        cancellation: &CancellationToken,
        mut on_chunk: F,
    ) -> Result<CompletionResult, LlamaClientError>
    where
        F: FnMut(StreamChunk) -> Result<(), String>,
    {
        let response = self.send(request, true, cancellation).await?;
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut pending_utf8 = Vec::new();
        let mut content = String::new();
        let mut reasoning = String::new();
        let mut final_result = CompletionResult {
            slot_id: request.slot_id.unwrap_or(-1),
            ..CompletionResult::default()
        };

        loop {
            let next = tokio::select! {
                _ = cancellation.cancelled() => return Err(LlamaClientError::Cancelled),
                item = stream.next() => item,
            };
            let Some(bytes) = next else {
                break;
            };
            let bytes = bytes.map_err(|error| LlamaClientError::Transport(error.to_string()))?;
            pending_utf8.extend_from_slice(&bytes);
            match std::str::from_utf8(&pending_utf8) {
                Ok(text) => {
                    buffer.push_str(text);
                    pending_utf8.clear();
                }
                Err(error) if error.error_len().is_none() => continue,
                Err(error) => {
                    return Err(LlamaClientError::InvalidResponse(error.to_string()));
                }
            }

            for event in drain_sse_events(&mut buffer) {
                let Some(payload) = parse_sse_event(&event) else {
                    continue;
                };
                let delta = payload
                    .get("content")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let reasoning_delta = payload
                    .get("reasoning_content")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                if !delta.is_empty() || !reasoning_delta.is_empty() {
                    content.push_str(&delta);
                    reasoning.push_str(&reasoning_delta);
                    on_chunk(StreamChunk {
                        delta,
                        reasoning_delta,
                        done: false,
                    })
                    .map_err(LlamaClientError::StreamConsumer)?;
                }
                if payload.get("stop").and_then(Value::as_bool) == Some(true) {
                    let envelope: CompletionEnvelope = serde_json::from_value(payload)
                        .map_err(|error| LlamaClientError::InvalidResponse(error.to_string()))?;
                    final_result = normalize_completion(envelope);
                    if final_result.content.is_empty() {
                        final_result.content.clone_from(&content);
                    }
                    if final_result.reasoning_content.is_empty() {
                        final_result.reasoning_content.clone_from(&reasoning);
                    }
                    on_chunk(StreamChunk {
                        delta: String::new(),
                        reasoning_delta: String::new(),
                        done: true,
                    })
                    .map_err(LlamaClientError::StreamConsumer)?;
                }
            }
        }
        if !pending_utf8.is_empty() {
            return Err(LlamaClientError::InvalidResponse(
                "stream ended inside a UTF-8 code point".into(),
            ));
        }

        if final_result.content.is_empty() {
            final_result.content = content;
        }
        if final_result.reasoning_content.is_empty() {
            final_result.reasoning_content = reasoning;
        }
        Ok(final_result)
    }

    async fn send(
        &self,
        request: &CompletionRequest,
        stream: bool,
        cancellation: &CancellationToken,
    ) -> Result<reqwest::Response, LlamaClientError> {
        let target = self.target();
        match self
            .send_to_target(&target, request, stream, cancellation)
            .await
        {
            Err(LlamaClientError::Http { status, detail })
                if is_context_limit_error(status, &detail) && self.context_expansion.is_some() =>
            {
                let hook = self.context_expansion.as_ref().unwrap();
                let replacement = match hook.expand(&target, cancellation).await {
                    Ok(replacement) => replacement,
                    Err(_) if cancellation.is_cancelled() => {
                        return Err(LlamaClientError::Cancelled);
                    }
                    Err(error) => return Err(LlamaClientError::Transport(error)),
                };
                if replacement.backend != target.backend
                    || !model_ids_match(&replacement.model_id, &target.model_id)
                {
                    return Err(LlamaClientError::Transport(
                        "Context expansion returned a different model or backend".into(),
                    ));
                }
                self.retarget(&replacement);
                match self.fetch_context_window(cancellation).await {
                    Err(LlamaClientError::Cancelled) => {
                        return Err(LlamaClientError::Cancelled);
                    }
                    Err(error) => {
                        log::warn!("Agent context profile refresh failed after expansion: {error}");
                    }
                    Ok(_) => {}
                }
                self.send_to_target(&replacement, request, stream, cancellation)
                    .await
            }
            result => result,
        }
    }

    async fn send_to_target(
        &self,
        target: &LlamaSessionTarget,
        request: &CompletionRequest,
        stream: bool,
        cancellation: &CancellationToken,
    ) -> Result<reqwest::Response, LlamaClientError> {
        let payload = CompletionPayload {
            prompt: &request.prompt,
            stream,
            cache_prompt: true,
            temperature: request.temperature,
            top_p: request.top_p,
            top_k: request.top_k,
            n_predict: request.max_tokens,
            repeat_penalty: request.repeat_penalty,
            repeat_last_n: request.repeat_last_n,
            grammar: request.grammar.as_deref(),
            stop: (!request.stop.is_empty()).then_some(request.stop.as_slice()),
            slot_id: request.slot_id,
            id_slot: request.slot_id,
        };
        let mut builder = self
            .client
            .post(format!("http://127.0.0.1:{}/completion", target.port))
            .header(CONTENT_TYPE, "application/json")
            .header(
                ACCEPT,
                if stream {
                    "text/event-stream"
                } else {
                    "application/json"
                },
            )
            .json(&payload);
        if !target.api_key.is_empty() {
            builder = builder.header(AUTHORIZATION, format!("Bearer {}", target.api_key));
        }
        let response = tokio::select! {
            _ = cancellation.cancelled() => return Err(LlamaClientError::Cancelled),
            result = builder.send() => {
                result.map_err(|error| LlamaClientError::Transport(error.to_string()))?
            }
        };
        if response.status().is_success() {
            return Ok(response);
        }
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        Err(LlamaClientError::Http {
            status,
            detail: extract_error_detail(&body),
        })
    }
}

fn vision_request_payload(model_id: &str, prompt: &str, images: &[(String, String)]) -> Value {
    let mut content = images
        .iter()
        .map(|(media_type, base64)| {
            serde_json::json!({
                "type": "image_url",
                "image_url": {
                    "url": format!("data:{media_type};base64,{base64}")
                }
            })
        })
        .collect::<Vec<_>>();
    content.push(serde_json::json!({"type": "text", "text": prompt}));
    serde_json::json!({
        "model": model_id,
        "messages": [{"role": "user", "content": content}],
        "stream": false,
        "max_tokens": 1024,
        "temperature": 0.2,
        "chat_template_kwargs": {"enable_thinking": false},
        "reasoning_format": "none"
    })
}

pub async fn find_session_by_model_id(
    model_id: &str,
    llamacpp: &LlamacppState,
    upstream: &LlamacppUpstreamState,
) -> Result<LlamaSessionTarget, LlamaClientError> {
    {
        let sessions = llamacpp.llama_server_process.lock().await;
        if let Some(session) = sessions
            .values()
            .find(|session| model_ids_match(&session.info.model_id, model_id))
        {
            return Ok(LlamaSessionTarget {
                port: session.info.port,
                api_key: session.info.api_key.clone(),
                model_id: session.info.model_id.clone(),
                has_vision: session.info.mmproj_path.is_some(),
                backend: LlamaBackend::Llamacpp,
            });
        }
    }
    let sessions = upstream.llama_server_process.lock().await;
    sessions
        .values()
        .find(|session| model_ids_match(&session.info.model_id, model_id))
        .map(|session| LlamaSessionTarget {
            port: session.info.port,
            api_key: session.info.api_key.clone(),
            model_id: session.info.model_id.clone(),
            has_vision: session.info.mmproj_path.is_some(),
            backend: LlamaBackend::LlamacppUpstream,
        })
        .ok_or_else(|| LlamaClientError::SessionNotFound(model_id.to_owned()))
}

pub async fn find_session_by_model_and_backend(
    model_id: &str,
    backend: LlamaBackend,
    llamacpp: &LlamacppState,
    upstream: &LlamacppUpstreamState,
) -> Result<LlamaSessionTarget, LlamaClientError> {
    match backend {
        LlamaBackend::Llamacpp => {
            let sessions = llamacpp.llama_server_process.lock().await;
            sessions
                .values()
                .find(|session| model_ids_match(&session.info.model_id, model_id))
                .map(|session| LlamaSessionTarget {
                    port: session.info.port,
                    api_key: session.info.api_key.clone(),
                    model_id: session.info.model_id.clone(),
                    has_vision: session.info.mmproj_path.is_some(),
                    backend,
                })
        }
        LlamaBackend::LlamacppUpstream => {
            let sessions = upstream.llama_server_process.lock().await;
            sessions
                .values()
                .find(|session| model_ids_match(&session.info.model_id, model_id))
                .map(|session| LlamaSessionTarget {
                    port: session.info.port,
                    api_key: session.info.api_key.clone(),
                    model_id: session.info.model_id.clone(),
                    has_vision: session.info.mmproj_path.is_some(),
                    backend,
                })
        }
    }
    .ok_or_else(|| LlamaClientError::SessionNotFound(model_id.to_owned()))
}

fn read_context_window(props: &Value) -> Option<usize> {
    props
        .pointer("/default_generation_settings/n_ctx")
        .or_else(|| props.get("n_ctx"))
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_str()?.parse::<u64>().ok())
        })
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value > 0)
}

pub fn parse_tool_calls(raw: &str) -> Result<ParsedToolCalls, LlamaClientError> {
    parse_tool_calls_for_profile(raw, AgentModelProfile::Plain)
}

pub fn parse_tool_calls_for_profile(
    raw: &str,
    profile: AgentModelProfile,
) -> Result<ParsedToolCalls, LlamaClientError> {
    let (reasoning, body) = match (profile.reasoning_open_tag(), profile.reasoning_close_tag()) {
        (Some(open), Some(close)) => extract_tagged_reasoning(raw, open, close),
        _ => extract_reasoning(raw),
    };
    let json_text = extract_json_root(&body)?;
    let parsed: Value = serde_json::from_str(json_text)
        .map_err(|error| LlamaClientError::ToolCallParse(error.to_string()))?;
    let entries = parsed.as_array().ok_or_else(|| {
        LlamaClientError::ToolCallParse("tool-call root must be a JSON array".into())
    })?;
    if entries.is_empty() {
        return Err(LlamaClientError::ToolCallParse(
            "tool-call array must contain at least one call".into(),
        ));
    }
    let calls = entries
        .iter()
        .enumerate()
        .map(|(index, entry)| normalize_tool_call(entry, index))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ParsedToolCalls {
        calls,
        reasoning: (!reasoning.is_empty()).then_some(reasoning),
    })
}

fn extract_tagged_reasoning(raw: &str, open_tag: &str, close_tag: &str) -> (String, String) {
    let trimmed = raw.trim_start();
    let Some(after_open) = trimmed.strip_prefix(open_tag) else {
        return (String::new(), raw.trim().to_owned());
    };
    let Some(close) = after_open.find(close_tag) else {
        return (after_open.trim().to_owned(), String::new());
    };
    (
        after_open[..close].trim().to_owned(),
        after_open[close + close_tag.len()..].trim().to_owned(),
    )
}

fn normalize_tool_call(value: &Value, index: usize) -> Result<ToolCallPayload, LlamaClientError> {
    let object = value.as_object().ok_or_else(|| {
        LlamaClientError::ToolCallParse(format!(
            "tool-call array entry {index} must be a JSON object"
        ))
    })?;
    let tool = ["tool", "name", "action"]
        .iter()
        .filter_map(|key| object.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .find(|name| !name.is_empty())
        .ok_or_else(|| {
            LlamaClientError::ToolCallParse("tool-call must include a non-empty tool name".into())
        })?
        .to_owned();
    let args = read_args(object)?;
    Ok(ToolCallPayload { tool, args })
}

fn read_args(object: &Map<String, Value>) -> Result<Value, LlamaClientError> {
    if let Some(nested) = object.get("args").or_else(|| object.get("arguments")) {
        let value = match nested {
            Value::String(raw) => serde_json::from_str(raw).map_err(|error| {
                LlamaClientError::ToolCallParse(format!(
                    "tool-call arguments must be valid JSON: {error}"
                ))
            })?,
            value => value.clone(),
        };
        if value.is_object() {
            return Ok(value);
        }
        return Err(LlamaClientError::ToolCallParse(
            "tool-call args must be a JSON object".into(),
        ));
    }
    let flat: Map<String, Value> = object
        .iter()
        .filter(|(key, _)| !matches!(key.as_str(), "tool" | "name" | "action"))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    if flat.is_empty() {
        return Err(LlamaClientError::ToolCallParse(
            "tool-call must include args".into(),
        ));
    }
    Ok(Value::Object(flat))
}

fn extract_reasoning(raw: &str) -> (String, String) {
    let mut reasoning = Vec::new();
    let mut body = String::new();
    let mut rest = raw;
    loop {
        let Some(open) = rest.find("<think>") else {
            body.push_str(rest);
            break;
        };
        body.push_str(&rest[..open]);
        let after_open = &rest[open + "<think>".len()..];
        let Some(close) = after_open.find("</think>") else {
            if let Ok(json) = extract_json_root(after_open) {
                let start = after_open.find(json).unwrap_or(after_open.len());
                let prefix = after_open[..start].trim();
                if !prefix.is_empty() {
                    reasoning.push(prefix.to_owned());
                }
                body.push_str(json);
            } else {
                reasoning.push(after_open.trim().to_owned());
            }
            break;
        };
        let thought = after_open[..close].trim();
        if !thought.is_empty() {
            reasoning.push(thought.to_owned());
        }
        rest = &after_open[close + "</think>".len()..];
    }
    (reasoning.join("\n\n"), body.trim().to_owned())
}

fn extract_json_root(raw: &str) -> Result<&str, LlamaClientError> {
    let input = raw.trim();
    if input.is_empty() {
        return Err(LlamaClientError::ToolCallParse(
            "tool-call body is empty".into(),
        ));
    }
    let mut start = None;
    let mut root = '\0';
    let mut curly = 0_i32;
    let mut square = 0_i32;
    let mut in_string = false;
    let mut escaped = false;
    for (index, ch) in input.char_indices() {
        if start.is_none() {
            if matches!(ch, '{' | '[') {
                start = Some(index);
                root = ch;
                if ch == '{' {
                    curly = 1;
                } else {
                    square = 1;
                }
            }
            continue;
        }
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '{' => curly += 1,
            '}' => {
                curly -= 1;
                if root == '{' && curly == 0 && square == 0 {
                    return Ok(&input[start.expect("JSON start is set")..index + ch.len_utf8()]);
                }
            }
            '[' => square += 1,
            ']' => {
                square -= 1;
                if root == '[' && square == 0 && curly == 0 {
                    return Ok(&input[start.expect("JSON start is set")..index + ch.len_utf8()]);
                }
            }
            _ => {}
        }
    }
    if start.is_none() {
        Err(LlamaClientError::ToolCallParse(
            "tool-call JSON value not found".into(),
        ))
    } else {
        Err(LlamaClientError::ToolCallParse(
            "tool-call JSON value is incomplete".into(),
        ))
    }
}

fn drain_sse_events(buffer: &mut String) -> Vec<String> {
    let normalized = buffer.replace("\r\n", "\n");
    *buffer = normalized;
    let mut events = Vec::new();
    while let Some(end) = buffer.find("\n\n") {
        events.push(buffer[..end].to_owned());
        buffer.drain(..end + 2);
    }
    events
}

fn parse_sse_event(raw: &str) -> Option<Value> {
    let data = raw
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim_start)
        .collect::<Vec<_>>()
        .join("\n");
    if data.is_empty() || data == "[DONE]" {
        return None;
    }
    serde_json::from_str(&data).ok()
}

fn normalize_completion(payload: CompletionEnvelope) -> CompletionResult {
    let timings = payload.timings.as_object();
    CompletionResult {
        content: payload.content,
        reasoning_content: payload.reasoning_content,
        stop: payload.stop,
        truncated: payload.truncated,
        timing: CompletionTiming {
            prompt_ms: number(timings.and_then(|value| value.get("prompt_ms"))),
            predicted_ms: number(timings.and_then(|value| value.get("predicted_ms"))),
            prompt_tokens: number(Some(
                timings
                    .and_then(|value| value.get("prompt_n"))
                    .unwrap_or(&payload.tokens_evaluated),
            )),
            predicted_tokens: number(Some(
                timings
                    .and_then(|value| value.get("predicted_n"))
                    .unwrap_or(&payload.tokens_predicted),
            )),
        },
        cache_hit_tokens: number(Some(&payload.tokens_cached)),
        slot_id: number_or(
            Some(if payload.slot_id.is_null() {
                &payload.id_slot
            } else {
                &payload.slot_id
            }),
            -1.0,
        ) as i32,
        model_id: payload.model,
    }
}

fn number(value: Option<&Value>) -> f64 {
    number_or(value, 0.0)
}

fn number_or(value: Option<&Value>, fallback: f64) -> f64 {
    value
        .and_then(|value| {
            value
                .as_f64()
                .or_else(|| value.as_str()?.parse::<f64>().ok())
        })
        .unwrap_or(fallback)
}

fn extract_error_detail(raw: &str) -> String {
    let trimmed = raw.trim();
    let parsed = serde_json::from_str::<Value>(trimmed).ok();
    let detail = parsed
        .as_ref()
        .and_then(|value| {
            value
                .get("error")
                .and_then(|error| {
                    error
                        .as_str()
                        .map(str::to_owned)
                        .or_else(|| error.get("message")?.as_str().map(str::to_owned))
                })
                .or_else(|| value.get("message")?.as_str().map(str::to_owned))
        })
        .unwrap_or_else(|| trimmed.to_owned());
    let collapsed = detail.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= ERROR_DETAIL_MAX_LEN {
        collapsed
    } else {
        let prefix = collapsed
            .chars()
            .take(ERROR_DETAIL_MAX_LEN - 1)
            .collect::<String>();
        format!("{prefix}…")
    }
}

fn model_ids_match(left: &str, right: &str) -> bool {
    left.len() == right.len()
        && left.bytes().zip(right.bytes()).all(|(left, right)| {
            left == right || matches!((left, right), (b'.', b'_') | (b'_', b'.'))
        })
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use reqwest::StatusCode;

    use super::*;
    use crate::core::agent::test_support::{ScriptedCompletionServer, ScriptedResponse};

    struct StaticExpansion {
        calls: AtomicUsize,
        result: Result<LlamaSessionTarget, String>,
    }

    #[async_trait]
    impl ContextExpansionHook for StaticExpansion {
        async fn expand(
            &self,
            _target: &LlamaSessionTarget,
            _cancellation: &CancellationToken,
        ) -> Result<LlamaSessionTarget, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.result.clone()
        }
    }

    struct CancellingExpansion;

    #[async_trait]
    impl ContextExpansionHook for CancellingExpansion {
        async fn expand(
            &self,
            _target: &LlamaSessionTarget,
            cancellation: &CancellationToken,
        ) -> Result<LlamaSessionTarget, String> {
            cancellation.cancel();
            Err("cancelled".into())
        }
    }

    #[test]
    fn normal_completion_uses_atomic_agent_limit() {
        let request = CompletionRequest::tool_call("prompt", "root ::= \"ok\"", 0);
        assert_eq!(request.max_tokens, 8_192);
    }

    #[test]
    fn reads_context_window_from_props_variants() {
        assert_eq!(
            read_context_window(&serde_json::json!({
                "default_generation_settings": {"n_ctx": 16_384},
                "n_ctx": 8_192
            })),
            Some(16_384)
        );
        assert_eq!(
            read_context_window(&serde_json::json!({"n_ctx": "32768"})),
            Some(32_768)
        );
        assert_eq!(read_context_window(&serde_json::json!({})), None);
        assert_eq!(read_context_window(&serde_json::json!({"n_ctx": 0})), None);
    }

    #[tokio::test]
    async fn fetches_model_profile_props_without_consuming_completion_script() {
        let props = serde_json::json!({
            "model_alias": "gemma-4-12b-it",
            "chat_template": "<|turn>system\n<|channel>thought\n<channel|><turn|>"
        });
        let server = ScriptedCompletionServer::start_with_props(
            vec![ScriptedResponse::completion("ok")],
            props.clone(),
        )
        .await;

        assert_eq!(
            server
                .client()
                .fetch_props(&CancellationToken::new())
                .await
                .expect("fetch props"),
            props
        );
        assert!(server.requests().is_empty());
    }

    #[tokio::test]
    async fn retries_once_after_context_expansion_and_retargets_same_backend() {
        let first = ScriptedCompletionServer::start(vec![ScriptedResponse::http_error(
            StatusCode::BAD_REQUEST,
            "the request exceeds the available context size",
        )])
        .await;
        let replacement =
            ScriptedCompletionServer::start(vec![ScriptedResponse::completion("ok")]).await;
        let replacement_target = replacement.client().target();
        let hook = Arc::new(StaticExpansion {
            calls: AtomicUsize::new(0),
            result: Ok(replacement_target.clone()),
        });
        let client = first.client().with_context_expansion(hook.clone());

        let completion = client
            .complete(
                &CompletionRequest::tool_call("prompt", "root ::= \"ok\"", 0),
                &CancellationToken::new(),
            )
            .await
            .expect("retry after context expansion");

        assert_eq!(completion.content, "ok");
        assert_eq!(hook.calls.load(Ordering::SeqCst), 1);
        assert_eq!(client.target().port, replacement_target.port);
        assert_eq!(client.target().backend, LlamaBackend::Llamacpp);
        assert_eq!(first.requests().len(), 1);
        assert_eq!(replacement.requests().len(), 1);
    }

    #[tokio::test]
    async fn does_not_expand_for_non_context_http_errors() {
        let server = ScriptedCompletionServer::start(vec![ScriptedResponse::http_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "backend crashed",
        )])
        .await;
        let hook = Arc::new(StaticExpansion {
            calls: AtomicUsize::new(0),
            result: Err("must not run".into()),
        });
        let client = server.client().with_context_expansion(hook.clone());

        let error = client
            .complete(
                &CompletionRequest::tool_call("prompt", "root ::= \"ok\"", 0),
                &CancellationToken::new(),
            )
            .await
            .unwrap_err();

        assert!(matches!(error, LlamaClientError::Http { status: 500, .. }));
        assert_eq!(hook.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn reports_context_expansion_failure_without_second_completion() {
        let server = ScriptedCompletionServer::start(vec![ScriptedResponse::http_error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "context length exceeded",
        )])
        .await;
        let hook = Arc::new(StaticExpansion {
            calls: AtomicUsize::new(0),
            result: Err("timeout_after_60s".into()),
        });
        let client = server.client().with_context_expansion(hook.clone());

        let error = client
            .complete(
                &CompletionRequest::tool_call("prompt", "root ::= \"ok\"", 0),
                &CancellationToken::new(),
            )
            .await
            .unwrap_err();

        assert!(error.to_string().contains("timeout_after_60s"));
        assert_eq!(hook.calls.load(Ordering::SeqCst), 1);
        assert_eq!(server.requests().len(), 1);
    }

    #[tokio::test]
    async fn cancellation_during_context_expansion_stops_without_retry() {
        let server = ScriptedCompletionServer::start(vec![ScriptedResponse::http_error(
            StatusCode::BAD_REQUEST,
            "context size exceeded",
        )])
        .await;
        let client = server
            .client()
            .with_context_expansion(Arc::new(CancellingExpansion));
        let cancellation = CancellationToken::new();

        let error = client
            .complete(
                &CompletionRequest::tool_call("prompt", "root ::= \"ok\"", 0),
                &cancellation,
            )
            .await
            .unwrap_err();

        assert!(matches!(error, LlamaClientError::Cancelled));
        assert_eq!(server.requests().len(), 1);
    }

    #[tokio::test]
    async fn rejects_context_expansion_target_from_another_backend() {
        let server = ScriptedCompletionServer::start(vec![ScriptedResponse::http_error(
            StatusCode::BAD_REQUEST,
            "context size exceeded",
        )])
        .await;
        let mut replacement = server.client().target();
        replacement.backend = LlamaBackend::LlamacppUpstream;
        let hook = Arc::new(StaticExpansion {
            calls: AtomicUsize::new(0),
            result: Ok(replacement),
        });
        let client = server.client().with_context_expansion(hook);

        let error = client
            .complete(
                &CompletionRequest::tool_call("prompt", "root ::= \"ok\"", 0),
                &CancellationToken::new(),
            )
            .await
            .unwrap_err();

        assert!(error.to_string().contains("different model or backend"));
        assert_eq!(client.target().backend, LlamaBackend::Llamacpp);
        assert_eq!(server.requests().len(), 1);
    }

    #[test]
    fn parses_batch_tool_calls_and_normalizes_aliases() {
        let parsed = parse_tool_calls(
            r#"<think>inspect both files</think>
            [
              {"tool":"os.fs.read","args":{"path":"a.json","nested":[1,{"x":"}"}]}},
              {"name":"os.git.status","arguments":"{\"path\":\".\"}"}
            ] trailing text"#,
        )
        .expect("batch should parse");

        assert_eq!(parsed.reasoning.as_deref(), Some("inspect both files"));
        assert_eq!(parsed.calls.len(), 2);
        assert_eq!(parsed.calls[0].tool, "os.fs.read");
        assert_eq!(parsed.calls[0].args["nested"][1]["x"], "}");
        assert_eq!(parsed.calls[1].tool, "os.git.status");
        assert_eq!(parsed.calls[1].args["path"], ".");
    }

    #[test]
    fn parses_gemma4_model_emitted_channel_reasoning() {
        let parsed = parse_tool_calls_for_profile(
            "<|channel>thought\ninspect the workspace<channel|>\
             [{\"tool\":\"reply\",\"args\":{\"text\":\"done\"}}]",
            AgentModelProfile::Gemma4Think,
        )
        .expect("Gemma channel output should parse");

        assert_eq!(parsed.reasoning.as_deref(), Some("inspect the workspace"));
        assert_eq!(parsed.calls[0].tool, "reply");
        assert_eq!(parsed.calls[0].args["text"], "done");
    }

    #[test]
    fn rejects_empty_and_non_array_roots() {
        assert!(parse_tool_calls("[]").is_err());
        assert!(parse_tool_calls(r#"{"tool":"reply","args":{"text":"x"}}"#).is_err());
    }

    #[test]
    fn parses_flat_arguments_for_legacy_model_output() {
        let parsed = parse_tool_calls(r#"[{"action":"reply","text":"done"}]"#)
            .expect("flat arguments should parse");
        assert_eq!(parsed.calls[0].args, serde_json::json!({"text": "done"}));
    }

    #[test]
    fn peels_json_after_unclosed_reasoning_tag() {
        let parsed = parse_tool_calls(
            "<think>Need answer\n[{\"tool\":\"reply\",\"args\":{\"text\":\"ok\"}}]",
        )
        .expect("unclosed reasoning should still parse");
        assert_eq!(parsed.reasoning.as_deref(), Some("Need answer"));
        assert_eq!(parsed.calls[0].tool, "reply");
    }

    #[test]
    fn parses_multiline_sse_and_done_marker() {
        let event = "event: message\ndata: {\"content\":\"hel\",\ndata: \"stop\":false}";
        let parsed = parse_sse_event(event).expect("SSE data should parse");
        assert_eq!(parsed["content"], "hel");
        assert_eq!(parsed["stop"], false);
        assert!(parse_sse_event("data: [DONE]").is_none());
        assert!(parse_sse_event("event: ping").is_none());
    }

    #[test]
    fn drains_crlf_and_fragmented_sse_frames() {
        let mut buffer =
            "data: {\"content\":\"a\",\"stop\":false}\r\n\r\ndata: {\"content\":\"b".to_owned();
        let first = drain_sse_events(&mut buffer);
        assert_eq!(first.len(), 1);
        buffer.push_str("\",\"stop\":true}\n\n");
        let second = drain_sse_events(&mut buffer);
        assert_eq!(second.len(), 1);
        assert_eq!(
            parse_sse_event(&second[0]).expect("second event")["content"],
            "b"
        );
    }

    #[test]
    fn extracts_and_caps_server_error_detail() {
        assert_eq!(
            extract_error_detail(r#"{"error":{"message":"context overflow"}}"#),
            "context overflow"
        );
        assert_eq!(extract_error_detail("  plain   error \n"), "plain error");
        assert_eq!(
            extract_error_detail(&"x".repeat(400)).chars().count(),
            ERROR_DETAIL_MAX_LEN
        );
    }

    #[test]
    fn builds_openai_vision_payload_without_agent_slot_fields() {
        let payload = vision_request_payload(
            "vision-model",
            "Read this image",
            &[("image/png".into(), "aGVsbG8=".into())],
        );
        assert_eq!(payload["model"], "vision-model");
        assert_eq!(
            payload["messages"][0]["content"][0]["image_url"]["url"],
            "data:image/png;base64,aGVsbG8="
        );
        assert_eq!(
            payload["messages"][0]["content"][1]["text"],
            "Read this image"
        );
        assert_eq!(payload["chat_template_kwargs"]["enable_thinking"], false);
        assert!(payload.get("slot_id").is_none());
        assert!(payload.get("grammar").is_none());
    }

    #[tokio::test]
    async fn rejects_runtime_vision_call_for_text_only_session() {
        let client = LlamaServerClient::new(&LlamaSessionTarget {
            port: 1,
            api_key: String::new(),
            model_id: "text-model".into(),
            has_vision: false,
            backend: LlamaBackend::Llamacpp,
        })
        .unwrap();
        let error = client
            .describe_images(
                "Describe",
                &[("image/png".into(), "aGVsbG8=".into())],
                &CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("session is not vision-capable"));
    }
}
