//! Translation shim from Chat Completions to OpenAI's Responses API.
//!
//! The mirror of `responses_shim.rs`. That one exists because Codex speaks only
//! Responses and our llama.cpp backends speak only Chat Completions; this one
//! exists because the ChatGPT subscription backend
//! (`https://chatgpt.com/backend-api/codex/responses`) speaks only Responses
//! and *our* clients — the app itself, and anything pointed at the Local API
//! Server — speak Chat Completions.
//!
//! Deliberately a sibling file rather than more of `responses_shim.rs`: the two
//! directions share no state, and that file's doc comment scopes it to inbound.
//!
//! What this module can and cannot promise: the conversions below follow the
//! published Responses wire format, and the tests pin them. The *endpoint's*
//! tolerances — which tool shapes it accepts, whether unknown fields are
//! ignored — are an undocumented contract that only live traffic can confirm.

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::core::server::responses_shim::flatten_content_to_text;

/// Prepended to every request's `instructions`. The endpoint is Codex's, and
/// its models otherwise assume a coding-agent harness that is not us.
pub const COMPATIBILITY_INSTRUCTIONS: &str = concat!(
    "You are operating inside Atomic Chat. Follow the user's instructions, ",
    "use only tools supplied in this request, and return concise, accurate results."
);

/// The Responses API caps ids at 64 characters.
const MAX_CALL_ID_LEN: usize = 64;

pub fn new_chat_completion_id() -> String {
    format!("chatcmpl-{}", Uuid::new_v4().simple())
}

fn new_call_id() -> String {
    format!("call_{}", Uuid::new_v4().simple())
}

/// A call id the Responses API will accept, preserving the original when it
/// already fits. An over-long id is truncated with a digest tail so two
/// different ids can never collapse onto one.
pub fn responses_call_id(value: &str) -> String {
    if value.len() <= MAX_CALL_ID_LEN {
        return value.to_string();
    }
    let digest = Sha256::digest(value.as_bytes());
    let hex: String = digest.iter().take(16).map(|b| format!("{b:02x}")).collect();
    format!("{}_{hex}", &value[..31])
}

/// Convert a Chat Completions request body into a Responses request body.
///
/// `stream` and `store` are forced by the caller rather than copied: the
/// subscription endpoint only streams, and we never want our conversations
/// retained server-side. The caller's own `stream` preference is honoured by
/// aggregating on the way back, not by asking for a non-streamed response.
pub fn chat_request_to_responses(body: &Value, prompt_cache_key: &str) -> Value {
    let mut instructions: Vec<String> = vec![COMPATIBILITY_INSTRUCTIONS.to_string()];
    let mut input: Vec<Value> = Vec::new();
    let mut assistant_index = 0usize;

    if let Some(messages) = body.get("messages").and_then(|m| m.as_array()) {
        for message in messages {
            let role = message
                .get("role")
                .and_then(|r| r.as_str())
                .unwrap_or("user");
            // Responses carries the system prompt out-of-band, so every
            // system/developer turn is hoisted into `instructions` in order.
            if role == "system" || role == "developer" {
                let text = flatten_content_to_text(message.get("content"));
                if !text.is_empty() {
                    instructions.push(text);
                }
                continue;
            }
            input.extend(chat_message_to_responses_items(message, &mut assistant_index));
        }
    }

    let mut out = Map::new();
    if let Some(model) = body.get("model") {
        out.insert("model".into(), model.clone());
    }
    out.insert("instructions".into(), json!(instructions.join("\n\n")));
    out.insert("input".into(), Value::Array(input));

    // Forced rather than copied: the endpoint only streams, and we never want
    // the conversation retained server-side. A client that asked for
    // `stream: false` is served by aggregating on the way back.
    out.insert("stream".into(), json!(true));
    out.insert("store".into(), json!(false));
    // Keeps the reasoning item replayable on the next turn, which is what lets
    // a tool-calling conversation continue coherently.
    out.insert("include".into(), json!(["reasoning.encrypted_content"]));
    out.insert("prompt_cache_key".into(), json!(prompt_cache_key));
    out.insert("parallel_tool_calls".into(), json!(true));

    let mut text = Map::new();
    text.insert("verbosity".into(), json!("low"));
    if let Some(format) = body
        .get("response_format")
        .and_then(chat_response_format_to_text)
    {
        text.insert("format".into(), format);
    }
    out.insert("text".into(), Value::Object(text));

    // NOT sent: `max_output_tokens`, `temperature`, `top_p`. The Codex
    // Responses endpoint rejects the token cap that the public Responses API
    // accepts — the subscription applies its own — and the sampling knobs are
    // not part of this contract. Forwarding any of them fails the request
    // outright, so a client's values are dropped here rather than passed on.

    if let Some(effort) = body
        .get("reasoning_effort")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
    {
        out.insert(
            "reasoning".into(),
            json!({"effort": effort, "summary": "auto"}),
        );
    }

    if let Some(tools) = body.get("tools").and_then(|t| t.as_array()) {
        let converted: Vec<Value> = tools.iter().filter_map(chat_tool_to_responses).collect();
        if !converted.is_empty() {
            out.insert("tools".into(), Value::Array(converted));
        }
    }
    out.insert(
        "tool_choice".into(),
        body.get("tool_choice")
            .map(chat_tool_choice_to_responses)
            .unwrap_or_else(|| json!("auto")),
    );

    Value::Object(out)
}

/// One Chat message becomes one or more Responses input items: an assistant
/// turn that carries both text and tool calls is two items, and a `tool` result
/// is a `function_call_output`.
pub fn chat_message_to_responses_items(
    message: &Value,
    assistant_index: &mut usize,
) -> Vec<Value> {
    let role = message
        .get("role")
        .and_then(|r| r.as_str())
        .unwrap_or("user");

    if role == "tool" {
        let call_id = message
            .get("tool_call_id")
            .and_then(|v| v.as_str())
            .map(responses_call_id)
            .unwrap_or_default();
        let output = match message.get("content") {
            Some(Value::String(s)) => s.clone(),
            Some(other) => other.to_string(),
            None => String::new(),
        };
        return vec![json!({
            "type": "function_call_output",
            "call_id": call_id,
            "output": output,
        })];
    }

    let mut items = Vec::new();
    let content = chat_content_to_responses_parts(message.get("content"), role);

    if role == "assistant" {
        // An assistant turn is replayed as a completed output item, which is
        // the shape the endpoint expects to see for its own past replies. A
        // user turn is a bare `{role, content}` — adding `type: "message"`
        // there is not what the contract carries.
        if !content.is_empty() {
            items.push(json!({
                "type": "message",
                "id": format!("msg_atomic_{assistant_index}"),
                "role": "assistant",
                "content": Value::Array(content),
                "status": "completed",
            }));
            *assistant_index += 1;
        }
    } else if !content.is_empty() {
        items.push(json!({"role": role, "content": Value::Array(content)}));
    }

    if let Some(calls) = message.get("tool_calls").and_then(|c| c.as_array()) {
        for call in calls {
            let function = call.get("function");
            let name = function
                .and_then(|f| f.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if name.is_empty() {
                continue;
            }
            let arguments = function
                .and_then(|f| f.get("arguments"))
                .and_then(|v| v.as_str())
                .unwrap_or("{}");
            let call_id = call
                .get("id")
                .and_then(|v| v.as_str())
                .map(responses_call_id)
                .unwrap_or_else(new_call_id);
            items.push(json!({
                "type": "function_call",
                "call_id": call_id,
                "name": name,
                "arguments": arguments,
            }));
        }
    }

    items
}

/// An output part carries `annotations`; an input part does not.
fn text_part(text_type: &str, text: &str) -> Value {
    if text_type == "output_text" {
        json!({"type": "output_text", "text": text, "annotations": []})
    } else {
        json!({"type": text_type, "text": text})
    }
}

/// Chat content (a string, or an array of typed parts) as Responses content
/// parts. The text part type differs by role: what the user sent is
/// `input_text`, what the assistant produced is `output_text`.
fn chat_content_to_responses_parts(content: Option<&Value>, role: &str) -> Vec<Value> {
    let text_type = if role == "assistant" {
        "output_text"
    } else {
        "input_text"
    };

    match content {
        Some(Value::String(s)) if !s.is_empty() => {
            vec![text_part(text_type, s)]
        }
        Some(Value::Array(parts)) => {
            let mut out = Vec::new();
            for part in parts {
                match part.get("type").and_then(|v| v.as_str()) {
                    Some("image_url") => {
                        // Chat nests the URL; Responses puts it on the part.
                        // Data URLs travel unchanged, which is how the app
                        // sends pasted images.
                        if let Some(url) = part
                            .get("image_url")
                            .and_then(|i| i.get("url"))
                            .and_then(|v| v.as_str())
                        {
                            out.push(
                                json!({"type": "input_image", "detail": "auto", "image_url": url}),
                            );
                        }
                    }
                    _ => {
                        if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                            if !text.is_empty() {
                                out.push(text_part(text_type, text));
                            }
                        }
                    }
                }
            }
            out
        }
        _ => Vec::new(),
    }
}

/// Chat nests the schema under `function`; Responses keeps it flat.
pub fn chat_tool_to_responses(tool: &Value) -> Option<Value> {
    if tool.get("type").and_then(|v| v.as_str()) != Some("function") {
        return None;
    }
    let function = tool.get("function")?;
    let mut out = Map::new();
    out.insert("type".into(), json!("function"));
    out.insert("name".into(), function.get("name")?.clone());
    if let Some(d) = function.get("description") {
        out.insert("description".into(), d.clone());
    }
    // Every object schema has to carry `properties`, including nested
    // combinators — the endpoint rejects one that does not, and a tool the
    // model cannot see is indistinguishable from a broken request.
    out.insert(
        "parameters".into(),
        normalize_function_schema(function.get("parameters")),
    );
    if let Some(s) = function.get("strict") {
        out.insert("strict".into(), s.clone());
    }
    Some(Value::Object(out))
}

/// Fill in `properties` on every object schema, recursing through the
/// combinators a JSON Schema can nest them under.
pub fn normalize_function_schema(schema: Option<&Value>) -> Value {
    let Some(Value::Object(node)) = schema else {
        return json!({"type": "object", "properties": {}});
    };

    let mut out = node.clone();
    for key in ["properties", "$defs", "definitions"] {
        if let Some(Value::Object(children)) = out.get(key).cloned() {
            let mapped: Map<String, Value> = children
                .into_iter()
                .map(|(name, child)| (name, normalize_function_schema(Some(&child))))
                .collect();
            out.insert(key.into(), Value::Object(mapped));
        }
    }
    for key in ["items", "additionalProperties", "not"] {
        if let Some(child @ Value::Object(_)) = out.get(key).cloned() {
            out.insert(key.into(), normalize_function_schema(Some(&child)));
        }
    }
    for key in ["anyOf", "oneOf", "allOf", "prefixItems"] {
        if let Some(Value::Array(children)) = out.get(key).cloned() {
            let mapped: Vec<Value> = children
                .iter()
                .map(|child| normalize_function_schema(Some(child)))
                .collect();
            out.insert(key.into(), Value::Array(mapped));
        }
    }

    let is_object = match out.get("type") {
        Some(Value::String(t)) => t == "object",
        Some(Value::Array(types)) => types.iter().any(|t| t.as_str() == Some("object")),
        _ => false,
    };
    if is_object && !matches!(out.get("properties"), Some(Value::Object(_))) {
        out.insert("properties".into(), json!({}));
    }

    Value::Object(out)
}

pub fn chat_tool_choice_to_responses(tc: &Value) -> Value {
    match tc {
        // "auto" | "none" | "required" mean the same on both sides.
        Value::String(_) => tc.clone(),
        Value::Object(_) => {
            if let Some(name) = tc
                .get("function")
                .and_then(|f| f.get("name"))
                .and_then(|v| v.as_str())
            {
                json!({"type": "function", "name": name})
            } else {
                tc.clone()
            }
        }
        _ => json!("auto"),
    }
}

pub fn chat_response_format_to_text(rf: &Value) -> Option<Value> {
    match rf.get("type").and_then(|v| v.as_str())? {
        "json_schema" => {
            let js = rf.get("json_schema")?;
            let mut out = Map::new();
            out.insert("type".into(), json!("json_schema"));
            if let Some(n) = js.get("name") {
                out.insert("name".into(), n.clone());
            }
            if let Some(s) = js.get("schema") {
                out.insert("schema".into(), s.clone());
            }
            if let Some(s) = js.get("strict") {
                out.insert("strict".into(), s.clone());
            }
            Some(Value::Object(out))
        }
        "json_object" => Some(json!({"type": "json_object"})),
        _ => None,
    }
}

/// Responses `usage` in the Chat Completions shape.
pub fn map_usage_reverse(usage: &Value) -> Value {
    let input = usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
    let output = usage
        .get("output_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let total = usage
        .get("total_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(input + output);
    json!({
        "prompt_tokens": input,
        "completion_tokens": output,
        "total_tokens": total
    })
}

/// One in-flight function call. Its position in `tools` *is* the index chat
/// chunks key on, so it is not stored a second time.
#[derive(Debug, Clone, Default)]
struct ToolAcc {
    call_id: String,
    name: String,
    arguments: String,
}

/// Turns a Responses event stream into `chat.completion.chunk` objects.
///
/// The inverse of `ResponsesStreamConverter`, and simpler: the chat chunk
/// protocol is flat, so there is no content-part/output-item bookkeeping to
/// mirror — only the tool-call index, which chat chunks key on and Responses
/// does not.
///
/// The same instance also accumulates the full reply, so a caller that asked
/// for `stream: false` can hand back one `chat.completion` object without a
/// second pass.
pub struct ChatChunkStreamConverter {
    id: String,
    model: String,
    created: u64,
    role_sent: bool,
    finished: bool,
    /// The upstream stopped at a cap rather than finishing the thought.
    incomplete: bool,
    tools: Vec<ToolAcc>,
    /// Responses item id → index into `tools`.
    tool_index_by_item: std::collections::HashMap<String, usize>,
    text: String,
    reasoning: String,
    usage: Option<Value>,
    /// Set when the upstream reported a failure instead of completing.
    error: Option<String>,
}

impl ChatChunkStreamConverter {
    pub fn new(model: impl Into<String>, created: u64) -> Self {
        Self {
            id: new_chat_completion_id(),
            model: model.into(),
            created,
            role_sent: false,
            finished: false,
            incomplete: false,
            tools: Vec::new(),
            tool_index_by_item: std::collections::HashMap::new(),
            text: String::new(),
            reasoning: String::new(),
            usage: None,
            error: None,
        }
    }

    fn chunk(&self, delta: Value, finish_reason: Option<&str>) -> Value {
        self.chunk_with_usage(delta, finish_reason, None)
    }

    fn chunk_with_usage(
        &self,
        delta: Value,
        finish_reason: Option<&str>,
        usage: Option<Value>,
    ) -> Value {
        let mut out = Map::new();
        out.insert("id".into(), json!(self.id));
        out.insert("object".into(), json!("chat.completion.chunk"));
        out.insert("created".into(), json!(self.created));
        out.insert("model".into(), json!(self.model));
        out.insert(
            "choices".into(),
            json!([{ "index": 0, "delta": delta, "finish_reason": finish_reason }]),
        );
        if let Some(usage) = usage {
            out.insert("usage".into(), usage);
        }
        Value::Object(out)
    }

    /// Chat clients expect the assistant role once, on the first chunk.
    fn role_prefix(&mut self, delta: &mut Map<String, Value>) {
        if !self.role_sent {
            delta.insert("role".into(), json!("assistant"));
            self.role_sent = true;
        }
    }

    fn finish_reason(&self) -> &'static str {
        if self.incomplete {
            "length"
        } else if self.tools.is_empty() {
            "stop"
        } else {
            "tool_calls"
        }
    }

    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    /// Feed one Responses event. Returns the chunks it produces, if any.
    pub fn on_event(&mut self, event: &Value) -> Vec<Value> {
        if self.finished {
            return Vec::new();
        }
        let Some(kind) = event.get("type").and_then(|v| v.as_str()) else {
            return Vec::new();
        };

        match kind {
            "response.created" | "response.in_progress" => {
                // The upstream echoes the model it actually served; prefer it
                // over whatever the client asked for.
                if let Some(model) = event
                    .get("response")
                    .and_then(|r| r.get("model"))
                    .and_then(|v| v.as_str())
                {
                    if !model.is_empty() {
                        self.model = model.to_string();
                    }
                }
                Vec::new()
            }

            "response.output_text.delta" => {
                let Some(text) = event.get("delta").and_then(|v| v.as_str()) else {
                    return Vec::new();
                };
                if text.is_empty() {
                    return Vec::new();
                }
                self.text.push_str(text);
                let mut delta = Map::new();
                self.role_prefix(&mut delta);
                delta.insert("content".into(), json!(text));
                vec![self.chunk(Value::Object(delta), None)]
            }

            // Reasoning has no standard Chat Completions field. `reasoning_content`
            // is the de-facto one (DeepSeek's, adopted by vLLM and others), and
            // it is what the app's own transport already understands.
            "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                let Some(text) = event.get("delta").and_then(|v| v.as_str()) else {
                    return Vec::new();
                };
                if text.is_empty() {
                    return Vec::new();
                }
                self.reasoning.push_str(text);
                let mut delta = Map::new();
                self.role_prefix(&mut delta);
                delta.insert("reasoning_content".into(), json!(text));
                vec![self.chunk(Value::Object(delta), None)]
            }

            // A refusal is still the assistant's reply; dropping it would end
            // the turn with an empty message and no reason.
            "response.refusal.delta" => {
                let Some(text) = event.get("delta").and_then(|v| v.as_str()) else {
                    return Vec::new();
                };
                if text.is_empty() {
                    return Vec::new();
                }
                self.text.push_str(text);
                let mut delta = Map::new();
                self.role_prefix(&mut delta);
                delta.insert("content".into(), json!(text));
                vec![self.chunk(Value::Object(delta), None)]
            }

            // Some streams deliver a function call whole, without an `added`
            // event or argument deltas. Guarded on the item id so a call that
            // did stream normally is not announced twice.
            "response.output_item.done" => {
                let Some(item) = event.get("item") else {
                    return Vec::new();
                };
                if item.get("type").and_then(|v| v.as_str()) != Some("function_call") {
                    return Vec::new();
                }
                let item_id = item
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                if self.tool_index_by_item.contains_key(&item_id) {
                    return Vec::new();
                }
                let Some(name) = item.get("name").and_then(|v| v.as_str()) else {
                    return Vec::new();
                };
                let call_id = item
                    .get("call_id")
                    .or_else(|| item.get("id"))
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
                    .unwrap_or_else(new_call_id);
                let arguments = item
                    .get("arguments")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();

                let index = self.tools.len();
                self.tools.push(ToolAcc {
                    call_id: call_id.clone(),
                    name: name.to_string(),
                    arguments: arguments.clone(),
                });
                self.tool_index_by_item.insert(item_id, index);

                let mut delta = Map::new();
                self.role_prefix(&mut delta);
                delta.insert(
                    "tool_calls".into(),
                    json!([{
                        "index": index,
                        "id": call_id,
                        "type": "function",
                        "function": {"name": name, "arguments": arguments}
                    }]),
                );
                vec![self.chunk(Value::Object(delta), None)]
            }

            "response.output_item.added" => {
                let Some(item) = event.get("item") else {
                    return Vec::new();
                };
                if item.get("type").and_then(|v| v.as_str()) != Some("function_call") {
                    return Vec::new();
                }
                let item_id = item
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let call_id = item
                    .get("call_id")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
                    .unwrap_or_else(new_call_id);
                let name = item
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();

                let index = self.tools.len();
                self.tools.push(ToolAcc {
                    call_id: call_id.clone(),
                    name: name.clone(),
                    arguments: String::new(),
                });
                self.tool_index_by_item.insert(item_id, index);

                let mut delta = Map::new();
                self.role_prefix(&mut delta);
                delta.insert(
                    "tool_calls".into(),
                    json!([{
                        "index": index,
                        "id": call_id,
                        "type": "function",
                        "function": {"name": name, "arguments": ""}
                    }]),
                );
                vec![self.chunk(Value::Object(delta), None)]
            }

            "response.function_call_arguments.delta" => {
                let Some(text) = event.get("delta").and_then(|v| v.as_str()) else {
                    return Vec::new();
                };
                let item_id = event.get("item_id").and_then(|v| v.as_str()).unwrap_or("");
                // Fall back to the newest call: a stream that omits `item_id`
                // is still unambiguous while only one call is open.
                let Some(&index) = self
                    .tool_index_by_item
                    .get(item_id)
                    .or_else(|| self.tool_index_by_item.values().max())
                else {
                    return Vec::new();
                };
                if let Some(tool) = self.tools.get_mut(index) {
                    tool.arguments.push_str(text);
                }

                let mut delta = Map::new();
                self.role_prefix(&mut delta);
                delta.insert(
                    "tool_calls".into(),
                    json!([{
                        "index": index,
                        "function": {"arguments": text}
                    }]),
                );
                vec![self.chunk(Value::Object(delta), None)]
            }

            // Terminal events. `response.incomplete` means the reply was cut
            // short by a cap, which is `length` — reporting it as `stop` would
            // tell the client a truncated answer was a finished one.
            "response.completed" | "response.incomplete" => {
                if let Some(usage) = event.get("response").and_then(|r| r.get("usage")) {
                    self.usage = Some(map_usage_reverse(usage));
                }
                self.finished = true;
                self.incomplete = kind == "response.incomplete";
                let reason = self.finish_reason();
                vec![self.chunk_with_usage(json!({}), Some(reason), self.usage.clone())]
            }

            "response.failed" | "error" => {
                self.error = Some(
                    event
                        .get("response")
                        .and_then(|r| r.get("error"))
                        .or_else(|| event.get("error"))
                        .and_then(|e| e.get("message"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("the ChatGPT backend reported a failure")
                        .to_string(),
                );
                self.finished = true;
                vec![self.chunk(json!({}), Some("stop"))]
            }

            _ => Vec::new(),
        }
    }

    /// Close out a stream that ended without a terminal event — a dropped
    /// connection, say. Emits the finish chunk the client is still waiting for.
    pub fn finish(&mut self) -> Vec<Value> {
        if self.finished {
            return Vec::new();
        }
        self.finished = true;
        vec![self.chunk(json!({}), Some(self.finish_reason()))]
    }

    /// The whole reply as one `chat.completion`, for a caller that asked for
    /// `stream: false`. The upstream only streams, so this is the aggregate of
    /// what was seen rather than a second request.
    pub fn into_chat_completion(self) -> Value {
        let mut message = Map::new();
        message.insert("role".into(), json!("assistant"));
        message.insert(
            "content".into(),
            if self.text.is_empty() {
                Value::Null
            } else {
                json!(self.text)
            },
        );
        if !self.reasoning.is_empty() {
            message.insert("reasoning_content".into(), json!(self.reasoning));
        }
        if !self.tools.is_empty() {
            let calls: Vec<Value> = self
                .tools
                .iter()
                .map(|t| {
                    json!({
                        "id": t.call_id,
                        "type": "function",
                        "function": {"name": t.name, "arguments": t.arguments}
                    })
                })
                .collect();
            message.insert("tool_calls".into(), Value::Array(calls));
        }

        let finish_reason = self.finish_reason();

        let mut out = Map::new();
        out.insert("id".into(), json!(self.id));
        out.insert("object".into(), json!("chat.completion"));
        out.insert("created".into(), json!(self.created));
        out.insert("model".into(), json!(self.model));
        out.insert(
            "choices".into(),
            json!([{
                "index": 0,
                "message": Value::Object(message),
                "finish_reason": finish_reason,
            }]),
        );
        if let Some(usage) = self.usage {
            out.insert("usage".into(), usage);
        }
        Value::Object(out)
    }
}
