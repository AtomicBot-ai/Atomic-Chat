//! Translation shim between OpenAI's Responses API (`/v1/responses`) and the
//! Chat Completions API (`/v1/chat/completions`).
//!
//! Codex CLI speaks only the Responses wire protocol — `wire_api = "responses"`
//! is its sole supported value as of v0.135 — but our llama.cpp backends
//! implement only Chat Completions. This module converts a Responses request
//! into a Chat Completions request and converts the Chat Completions reply
//! (both the single-shot JSON form and the streamed SSE form) back into
//! Responses objects/events, so Codex — and any other Responses-only client —
//! works against a local GGUF model.
//!
//! MLX sessions and remote providers serve `/v1/responses` natively, so the
//! proxy forwards those untouched (see the passthrough branch in `proxy.rs`);
//! only the turboquant / upstream llama.cpp backends go through this shim.

use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use uuid::Uuid;

pub fn new_response_id() -> String {
    format!("resp_{}", Uuid::new_v4().simple())
}

fn new_message_id() -> String {
    format!("msg_{}", Uuid::new_v4().simple())
}

fn new_fc_id() -> String {
    format!("fc_{}", Uuid::new_v4().simple())
}

/// Convert a Responses API request body into a Chat Completions request body.
pub fn responses_request_to_chat(body: &Value) -> Value {
    let mut messages: Vec<Value> = Vec::new();

    // `instructions` (the system prompt in the Responses API) becomes a leading
    // system message.
    if let Some(instr) = body.get("instructions").and_then(|v| v.as_str()) {
        if !instr.is_empty() {
            messages.push(json!({"role": "system", "content": instr}));
        }
    }

    match body.get("input") {
        Some(Value::String(s)) => {
            messages.push(json!({"role": "user", "content": s}));
        }
        Some(Value::Array(items)) => {
            for item in items {
                if let Some(msg) = responses_input_item_to_chat(item) {
                    messages.push(msg);
                }
            }
        }
        _ => {}
    }

    let messages = merge_system_messages(messages);

    let mut out = json!({ "messages": messages });
    let obj = out.as_object_mut().unwrap();

    if let Some(model) = body.get("model") {
        obj.insert("model".into(), model.clone());
    }
    if let Some(stream) = body.get("stream") {
        obj.insert("stream".into(), stream.clone());
        // Ask the backend to include a usage block in the final streamed chunk
        // so we can populate Responses `usage` on `response.completed`.
        if stream.as_bool() == Some(true) {
            obj.insert("stream_options".into(), json!({"include_usage": true}));
        }
    }
    if let Some(v) = body.get("temperature") {
        obj.insert("temperature".into(), v.clone());
    }
    if let Some(v) = body.get("top_p") {
        obj.insert("top_p".into(), v.clone());
    }
    // Responses caps output with `max_output_tokens`; Chat uses `max_tokens`.
    if let Some(v) = body.get("max_output_tokens") {
        obj.insert("max_tokens".into(), v.clone());
    }
    if let Some(v) = body.get("parallel_tool_calls") {
        obj.insert("parallel_tool_calls".into(), v.clone());
    }

    if let Some(tools) = body.get("tools").and_then(|t| t.as_array()) {
        let chat_tools: Vec<Value> = tools.iter().filter_map(responses_tool_to_chat).collect();
        if !chat_tools.is_empty() {
            obj.insert("tools".into(), Value::Array(chat_tools));
        }
    }
    if let Some(tc) = body.get("tool_choice") {
        obj.insert("tool_choice".into(), responses_tool_choice_to_chat(tc));
    }

    // Structured output: Responses `text.format` -> Chat `response_format`.
    if let Some(format) = body.get("text").and_then(|t| t.get("format")) {
        if let Some(rf) = responses_text_format_to_chat(format) {
            obj.insert("response_format".into(), rf);
        }
    }

    out
}

/// Collapse every `system`/`developer` message into a single leading `system`
/// message. Strict chat templates (notably the Qwen3-family GGUFs) `raise`
/// "System message must be at the beginning" whenever a request carries more
/// than one system message or places one after the first turn — which Codex
/// readily does by combining `instructions` with developer/system input items.
/// Order of the remaining (non-system) messages is preserved.
///
/// Also reused by the Anthropic `/messages` proxy path (Claude Code), which can
/// likewise emit more than one system message after conversion.
pub(crate) fn merge_system_messages(messages: Vec<Value>) -> Vec<Value> {
    let mut system_parts: Vec<String> = Vec::new();
    let mut rest: Vec<Value> = Vec::with_capacity(messages.len());

    for msg in messages {
        let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("");
        if role == "system" || role == "developer" {
            let text = flatten_content_to_text(msg.get("content"));
            if !text.is_empty() {
                system_parts.push(text);
            }
        } else {
            rest.push(msg);
        }
    }

    if system_parts.is_empty() {
        return rest;
    }

    let mut out = Vec::with_capacity(rest.len() + 1);
    out.push(json!({"role": "system", "content": system_parts.join("\n\n")}));
    out.extend(rest);
    out
}

fn responses_input_item_to_chat(item: &Value) -> Option<Value> {
    let ty = item
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("message");
    match ty {
        "message" => {
            let role = item.get("role").and_then(|v| v.as_str()).unwrap_or("user");
            let text = flatten_content_to_text(item.get("content"));
            Some(json!({"role": role, "content": text}))
        }
        "function_call" => {
            let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let args = item
                .get("arguments")
                .and_then(|v| v.as_str())
                .unwrap_or("{}");
            let call_id = item
                .get("call_id")
                .or_else(|| item.get("id"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            Some(json!({
                "role": "assistant",
                "content": Value::Null,
                "tool_calls": [{
                    "id": call_id,
                    "type": "function",
                    "function": {"name": name, "arguments": args}
                }]
            }))
        }
        "function_call_output" => {
            let call_id = item.get("call_id").and_then(|v| v.as_str()).unwrap_or("");
            let content = match item.get("output") {
                Some(Value::String(s)) => s.clone(),
                Some(other) => other.to_string(),
                None => String::new(),
            };
            Some(json!({
                "role": "tool",
                "tool_call_id": call_id,
                "content": content
            }))
        }
        // Reasoning items (and any other Responses-only item) have no Chat
        // Completions equivalent; drop them from the replayed conversation.
        _ => None,
    }
}

/// Flatten Responses content (a string, or an array of typed parts) to plain
/// text. Non-text parts (images/files) are ignored on the text-only Chat path.
pub(crate) fn flatten_content_to_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => {
            let mut buf = String::new();
            for part in parts {
                if let Some(t) = part.get("text").and_then(|v| v.as_str()) {
                    buf.push_str(t);
                }
            }
            buf
        }
        _ => String::new(),
    }
}

fn responses_tool_to_chat(tool: &Value) -> Option<Value> {
    // A Responses function tool is flat: {type, name, description, parameters}.
    // Built-in tools (web_search, etc.) have no Chat equivalent and are dropped.
    if tool.get("type").and_then(|v| v.as_str()) != Some("function") {
        return None;
    }
    let name = tool.get("name")?.clone();
    let mut func = Map::new();
    func.insert("name".into(), name);
    if let Some(d) = tool.get("description") {
        func.insert("description".into(), d.clone());
    }
    if let Some(p) = tool.get("parameters") {
        func.insert("parameters".into(), p.clone());
    }
    Some(json!({"type": "function", "function": Value::Object(func)}))
}

fn responses_tool_choice_to_chat(tc: &Value) -> Value {
    match tc {
        // "auto" | "none" | "required" pass through unchanged.
        Value::String(_) => tc.clone(),
        Value::Object(_) => {
            if let Some(name) = tc.get("name").and_then(|v| v.as_str()) {
                json!({"type": "function", "function": {"name": name}})
            } else {
                tc.clone()
            }
        }
        _ => json!("auto"),
    }
}

fn responses_text_format_to_chat(format: &Value) -> Option<Value> {
    match format.get("type").and_then(|v| v.as_str())? {
        "json_schema" => {
            let mut js = Map::new();
            if let Some(n) = format.get("name") {
                js.insert("name".into(), n.clone());
            }
            if let Some(s) = format.get("schema") {
                js.insert("schema".into(), s.clone());
            }
            if let Some(strict) = format.get("strict") {
                js.insert("strict".into(), strict.clone());
            }
            Some(json!({"type": "json_schema", "json_schema": Value::Object(js)}))
        }
        "json_object" => Some(json!({"type": "json_object"})),
        _ => None,
    }
}

/// Map a Chat Completions `usage` block to the Responses `usage` shape.
fn map_usage(u: &Value) -> Value {
    let input = u.get("prompt_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
    let output = u
        .get("completion_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let total = u
        .get("total_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(input + output);
    json!({
        "input_tokens": input,
        "input_tokens_details": {"cached_tokens": 0},
        "output_tokens": output,
        "output_tokens_details": {"reasoning_tokens": 0},
        "total_tokens": total
    })
}

/// Build the `output` array (assistant message + function_call items) from a
/// Chat Completions assistant message.
fn message_to_output_items(message: Option<&Value>) -> Vec<Value> {
    let mut output: Vec<Value> = Vec::new();
    let Some(msg) = message else {
        return output;
    };

    if let Some(text) = msg.get("content").and_then(|v| v.as_str()) {
        if !text.is_empty() {
            output.push(json!({
                "type": "message",
                "id": new_message_id(),
                "status": "completed",
                "role": "assistant",
                "content": [{"type": "output_text", "text": text, "annotations": []}]
            }));
        }
    }

    if let Some(tool_calls) = msg.get("tool_calls").and_then(|v| v.as_array()) {
        for tc in tool_calls {
            let name = tc
                .get("function")
                .and_then(|f| f.get("name"))
                .cloned()
                .unwrap_or_else(|| json!(""));
            let args = tc
                .get("function")
                .and_then(|f| f.get("arguments"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let call_id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("");
            output.push(json!({
                "type": "function_call",
                "id": new_fc_id(),
                "call_id": call_id,
                "name": name,
                "arguments": args,
                "status": "completed"
            }));
        }
    }

    output
}

/// Convert a non-streaming Chat Completions response into a Responses object.
pub fn chat_response_to_responses(chat: &Value, response_id: &str, model_fallback: &str) -> Value {
    let model = chat
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or(model_fallback);
    let created = chat.get("created").and_then(|v| v.as_u64()).unwrap_or(0);

    let message = chat
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|c| c.first())
        .and_then(|c| c.get("message"));

    let output = message_to_output_items(message);
    let usage = chat.get("usage").map(map_usage).unwrap_or(Value::Null);

    json!({
        "id": response_id,
        "object": "response",
        "created_at": created,
        "status": "completed",
        "model": model,
        "output": output,
        "usage": usage,
        "parallel_tool_calls": true,
        "tool_choice": "auto",
        "tools": []
    })
}

struct ToolAcc {
    item_id: String,
    output_index: usize,
    call_id: String,
    name: String,
    args: String,
    added: bool,
}

/// Stateful converter from a Chat Completions SSE stream to the Responses SSE
/// event protocol. Feed each parsed Chat `data:` JSON chunk to [`on_chunk`] and
/// emit the returned events; call [`finish`] when the stream ends (`[DONE]`).
///
/// Emits the event sequence Codex consumes: `response.created`, per-item
/// `response.output_item.added` / `response.output_text.delta` /
/// `response.function_call_arguments.delta`, the matching `*.done` events, and
/// a terminal `response.completed` carrying the full `output` and `usage`.
pub struct ResponsesStreamConverter {
    response_id: String,
    model: String,
    seq: u64,
    next_output_index: usize,
    // assistant text message item
    msg_item_id: Option<String>,
    msg_output_index: usize,
    text: String,
    // tool calls keyed by the Chat `tool_calls[].index`
    tools: BTreeMap<u64, ToolAcc>,
}

impl ResponsesStreamConverter {
    pub fn new(response_id: String, model: String) -> Self {
        Self {
            response_id,
            model,
            seq: 0,
            next_output_index: 0,
            msg_item_id: None,
            msg_output_index: 0,
            text: String::new(),
            tools: BTreeMap::new(),
        }
    }

    fn next_seq(&mut self) -> u64 {
        let s = self.seq;
        self.seq += 1;
        s
    }

    fn response_envelope(&self, status: &str, output: Value, usage: Value) -> Value {
        json!({
            "id": self.response_id,
            "object": "response",
            "status": status,
            "model": self.model,
            "output": output,
            "usage": usage,
            "parallel_tool_calls": true,
            "tool_choice": "auto",
            "tools": []
        })
    }

    /// The opening `response.created` event. Send once, before any chunk.
    pub fn created_event(&mut self) -> Value {
        let seq = self.next_seq();
        json!({
            "type": "response.created",
            "sequence_number": seq,
            "response": self.response_envelope("in_progress", json!([]), Value::Null)
        })
    }

    pub fn on_chunk(&mut self, chunk: &Value) -> Vec<Value> {
        let mut events: Vec<Value> = Vec::new();
        let Some(choice) = chunk
            .get("choices")
            .and_then(|c| c.as_array())
            .and_then(|c| c.first())
        else {
            return events;
        };
        let Some(delta) = choice.get("delta") else {
            return events;
        };

        // Text content delta.
        if let Some(text) = delta.get("content").and_then(|v| v.as_str()) {
            if !text.is_empty() {
                if self.msg_item_id.is_none() {
                    let item_id = new_message_id();
                    let output_index = self.next_output_index;
                    self.next_output_index += 1;
                    self.msg_item_id = Some(item_id.clone());
                    self.msg_output_index = output_index;

                    let seq = self.next_seq();
                    events.push(json!({
                        "type": "response.output_item.added",
                        "sequence_number": seq,
                        "output_index": output_index,
                        "item": {
                            "type": "message",
                            "id": item_id,
                            "status": "in_progress",
                            "role": "assistant",
                            "content": []
                        }
                    }));
                    let seq = self.next_seq();
                    events.push(json!({
                        "type": "response.content_part.added",
                        "sequence_number": seq,
                        "item_id": self.msg_item_id.clone(),
                        "output_index": output_index,
                        "content_index": 0,
                        "part": {"type": "output_text", "text": "", "annotations": []}
                    }));
                }
                self.text.push_str(text);
                let seq = self.next_seq();
                events.push(json!({
                    "type": "response.output_text.delta",
                    "sequence_number": seq,
                    "item_id": self.msg_item_id.clone(),
                    "output_index": self.msg_output_index,
                    "content_index": 0,
                    "delta": text
                }));
            }
        }

        // Tool-call deltas.
        if let Some(tool_calls) = delta.get("tool_calls").and_then(|v| v.as_array()) {
            for tc in tool_calls {
                let index = tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0);
                let is_new = !self.tools.contains_key(&index);
                if is_new {
                    let output_index = self.next_output_index;
                    self.next_output_index += 1;
                    self.tools.insert(
                        index,
                        ToolAcc {
                            item_id: new_fc_id(),
                            output_index,
                            call_id: String::new(),
                            name: String::new(),
                            args: String::new(),
                            added: false,
                        },
                    );
                }
                let acc = self.tools.get_mut(&index).unwrap();
                if let Some(id) = tc.get("id").and_then(|v| v.as_str()) {
                    if !id.is_empty() {
                        acc.call_id = id.to_string();
                    }
                }
                if let Some(name) = tc
                    .get("function")
                    .and_then(|f| f.get("name"))
                    .and_then(|v| v.as_str())
                {
                    if !name.is_empty() {
                        acc.name.push_str(name);
                    }
                }

                if !acc.added {
                    acc.added = true;
                    let item_id = acc.item_id.clone();
                    let output_index = acc.output_index;
                    let call_id = acc.call_id.clone();
                    let name = acc.name.clone();
                    let seq = self.next_seq();
                    events.push(json!({
                        "type": "response.output_item.added",
                        "sequence_number": seq,
                        "output_index": output_index,
                        "item": {
                            "type": "function_call",
                            "id": item_id,
                            "status": "in_progress",
                            "call_id": call_id,
                            "name": name,
                            "arguments": ""
                        }
                    }));
                }

                if let Some(args) = tc
                    .get("function")
                    .and_then(|f| f.get("arguments"))
                    .and_then(|v| v.as_str())
                {
                    if !args.is_empty() {
                        let acc = self.tools.get_mut(&index).unwrap();
                        acc.args.push_str(args);
                        let item_id = acc.item_id.clone();
                        let output_index = acc.output_index;
                        let seq = self.next_seq();
                        events.push(json!({
                            "type": "response.function_call_arguments.delta",
                            "sequence_number": seq,
                            "item_id": item_id,
                            "output_index": output_index,
                            "delta": args
                        }));
                    }
                }
            }
        }

        events
    }

    /// Closing events: per-item `*.done` plus the terminal `response.completed`.
    pub fn finish(&mut self, usage: Option<&Value>) -> Vec<Value> {
        let mut events: Vec<Value> = Vec::new();

        // Ordered output items for the final envelope.
        let mut items: Vec<(usize, Value)> = Vec::new();

        if let Some(item_id) = self.msg_item_id.clone() {
            let output_index = self.msg_output_index;
            let text = self.text.clone();

            let seq = self.next_seq();
            events.push(json!({
                "type": "response.output_text.done",
                "sequence_number": seq,
                "item_id": item_id,
                "output_index": output_index,
                "content_index": 0,
                "text": text
            }));
            let seq = self.next_seq();
            events.push(json!({
                "type": "response.content_part.done",
                "sequence_number": seq,
                "item_id": item_id,
                "output_index": output_index,
                "content_index": 0,
                "part": {"type": "output_text", "text": text, "annotations": []}
            }));
            let item = json!({
                "type": "message",
                "id": item_id,
                "status": "completed",
                "role": "assistant",
                "content": [{"type": "output_text", "text": text, "annotations": []}]
            });
            let seq = self.next_seq();
            events.push(json!({
                "type": "response.output_item.done",
                "sequence_number": seq,
                "output_index": output_index,
                "item": item.clone()
            }));
            items.push((output_index, item));
        }

        let tools = std::mem::take(&mut self.tools);
        for acc in tools.values() {
            let seq = self.next_seq();
            events.push(json!({
                "type": "response.function_call_arguments.done",
                "sequence_number": seq,
                "item_id": acc.item_id,
                "output_index": acc.output_index,
                "arguments": acc.args
            }));
            let item = json!({
                "type": "function_call",
                "id": acc.item_id,
                "status": "completed",
                "call_id": acc.call_id,
                "name": acc.name,
                "arguments": acc.args
            });
            let seq = self.next_seq();
            events.push(json!({
                "type": "response.output_item.done",
                "sequence_number": seq,
                "output_index": acc.output_index,
                "item": item.clone()
            }));
            items.push((acc.output_index, item));
        }

        items.sort_by_key(|(idx, _)| *idx);
        let output: Vec<Value> = items.into_iter().map(|(_, v)| v).collect();
        let usage = usage.map(map_usage).unwrap_or(Value::Null);

        let seq = self.next_seq();
        events.push(json!({
            "type": "response.completed",
            "sequence_number": seq,
            "response": self.response_envelope("completed", Value::Array(output), usage)
        }));

        events
    }
}

// -- Contract fixtures
//
// Emits the JSON contract fixtures a TypeScript port replays. Run with
// `cargo test --lib -- --ignored server::responses_shim::fixture_dump`.
#[cfg(test)]
mod fixture_dump {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// Replaces uuid-minted ids (`msg_<32hex>`, `fc_<32hex>`) with numbered
    /// placeholders, in order of first appearance, so the linkage between an
    /// item's `added`/`delta`/`done` events survives without the random bytes.
    struct Normalizer {
        seen: Vec<(String, String)>,
    }

    impl Normalizer {
        fn new() -> Self {
            Self { seen: Vec::new() }
        }

        fn is_uuid_id(s: &str, prefix: &str) -> bool {
            s.strip_prefix(prefix)
                .is_some_and(|rest| rest.len() == 32 && rest.bytes().all(|b| b.is_ascii_hexdigit()))
        }

        fn placeholder(&mut self, s: &str) -> Option<String> {
            let kind = if Self::is_uuid_id(s, "msg_") {
                "msg_id"
            } else if Self::is_uuid_id(s, "fc_") {
                "fc_id"
            } else {
                return None;
            };
            if let Some((_, p)) = self.seen.iter().find(|(k, _)| k == s) {
                return Some(p.clone());
            }
            let n = self
                .seen
                .iter()
                .filter(|(_, p)| p.starts_with(&format!("<{kind}_")))
                .count();
            let p = format!("<{kind}_{n}>");
            self.seen.push((s.to_string(), p.clone()));
            Some(p)
        }

        fn normalize(&mut self, v: &mut Value) {
            match v {
                Value::String(s) => {
                    if let Some(p) = self.placeholder(s) {
                        *s = p;
                    }
                }
                Value::Array(items) => items.iter_mut().for_each(|x| self.normalize(x)),
                Value::Object(map) => map.values_mut().for_each(|x| self.normalize(x)),
                _ => {}
            }
        }

        fn placeholders(&self) -> Vec<String> {
            self.seen.iter().map(|(_, p)| p.clone()).collect()
        }
    }

    enum Kind {
        /// `responses_request_to_chat(body)`.
        Request(Value),
        /// `chat_response_to_responses(chat, response_id, model_fallback)`.
        Response(Value),
        /// `created_event()` + `on_chunk(each)` + `finish(last non-null usage)`.
        Stream(Vec<Value>),
    }

    struct Case {
        name: &'static str,
        kind: Kind,
    }

    const RESPONSE_ID: &str = "resp_fixture";
    const MODEL_FALLBACK: &str = "fallback-model";
    const STREAM_MODEL: &str = "fixture-model";

    fn req(name: &'static str, body: Value) -> Case {
        Case {
            name,
            kind: Kind::Request(body),
        }
    }

    fn resp(name: &'static str, chat: Value) -> Case {
        Case {
            name,
            kind: Kind::Response(chat),
        }
    }

    fn stream(name: &'static str, chunks: Vec<Value>) -> Case {
        Case {
            name,
            kind: Kind::Stream(chunks),
        }
    }

    fn cases() -> Vec<Case> {
        vec![
            // ── request: input / instructions ──────────────────────────────
            req(
                "request_string_input_with_instructions_stream",
                json!({
                    "model": "m", "instructions": "you are helpful", "input": "hello", "stream": true
                }),
            ),
            req(
                "request_stream_false_no_stream_options",
                json!({
                    "model": "m", "input": "hello", "stream": false
                }),
            ),
            req(
                "request_stream_absent_omitted",
                json!({"model": "m", "input": "hello"}),
            ),
            req(
                "request_empty_instructions_dropped",
                json!({
                    "model": "m", "instructions": "", "input": "hi"
                }),
            ),
            req(
                "request_input_missing_gives_empty_messages",
                json!({"model": "m"}),
            ),
            req(
                "request_input_non_string_non_array_ignored",
                json!({"model": "m", "input": 42}),
            ),
            req(
                "request_message_items_all_roles",
                json!({
                    "model": "m",
                    "input": [
                        {"type": "message", "role": "user", "content": "plain string"},
                        {"type": "message", "role": "assistant",
                         "content": [{"type": "output_text", "text": "prior answer"}]},
                        {"type": "message", "role": "user",
                         "content": [{"type": "input_text", "text": "look: "},
                                     {"type": "input_image", "image_url": "data:image/png;base64,AAA"},
                                     {"type": "input_text", "text": "what is it"}]}
                    ]
                }),
            ),
            req(
                "request_merges_system_and_developer_into_leading_system",
                json!({
                    "model": "m",
                    "instructions": "base policy",
                    "input": [
                        {"type": "message", "role": "developer",
                         "content": [{"type": "input_text", "text": "project rules"}]},
                        {"type": "message", "role": "user",
                         "content": [{"type": "input_text", "text": "hi"}]},
                        {"type": "message", "role": "system",
                         "content": [{"type": "input_text", "text": "late system"}]}
                    ]
                }),
            ),
            req(
                "request_item_without_type_or_role_defaults_user_message",
                json!({
                    "model": "m", "input": [{"content": "no type no role"}]
                }),
            ),
            req(
                "request_message_without_content_gives_empty_string",
                json!({
                    "model": "m", "input": [{"type": "message", "role": "user"}]
                }),
            ),
            req(
                "request_content_parts_any_type_with_text_concatenated",
                json!({
                    "model": "m",
                    "input": [{"type": "message", "role": "user", "content": [
                        {"type": "input_text", "text": "a"},
                        {"type": "output_text", "text": "b"},
                        {"type": "input_file", "filename": "x.pdf"},
                        {"text": "c"},
                        {"type": "input_text", "text": 7}
                    ]}]
                }),
            ),
            req(
                "request_system_only_input_yields_single_system",
                json!({
                    "model": "m",
                    "input": [
                        {"type": "message", "role": "system", "content": "one"},
                        {"type": "message", "role": "system", "content": "two"}
                    ]
                }),
            ),
            req(
                "request_all_system_text_empty_yields_no_system",
                json!({
                    "model": "m",
                    "instructions": "",
                    "input": [
                        {"type": "message", "role": "system", "content": ""},
                        {"type": "message", "role": "developer", "content": []},
                        {"type": "message", "role": "user", "content": "hi"}
                    ]
                }),
            ),
            // ── request: tool call replay ──────────────────────────────────
            req(
                "request_function_call_and_output_items",
                json!({
                    "model": "m",
                    "input": [
                        {"type": "message", "role": "user",
                         "content": [{"type": "input_text", "text": "run ls"}]},
                        {"type": "function_call", "name": "shell",
                         "arguments": "{\"cmd\":\"ls\"}", "call_id": "call_1"},
                        {"type": "function_call_output", "call_id": "call_1", "output": "file.txt"}
                    ]
                }),
            ),
            req(
                "request_function_call_falls_back_to_id_and_defaults",
                json!({
                    "model": "m",
                    "input": [
                        {"type": "function_call", "id": "fc_abc"},
                        {"type": "function_call", "name": "x", "arguments": "{}", "call_id": "call_2", "id": "fc_2"}
                    ]
                }),
            ),
            req(
                "request_function_call_output_non_string_serialised",
                json!({
                    "model": "m",
                    "input": [
                        {"type": "function_call_output", "call_id": "call_1", "output": {"a": 1, "b": [true, null]}},
                        {"type": "function_call_output", "call_id": "call_2", "output": 3.5},
                        {"type": "function_call_output"}
                    ]
                }),
            ),
            req(
                "request_reasoning_and_unknown_items_dropped",
                json!({
                    "model": "m",
                    "input": [
                        {"type": "reasoning", "summary": [], "encrypted_content": "zzz"},
                        {"type": "web_search_call", "id": "ws_1"},
                        {"type": "item_reference", "id": "msg_1"},
                        {"type": "message", "role": "user", "content": "kept"}
                    ]
                }),
            ),
            // ── request: tools / tool_choice ───────────────────────────────
            req(
                "request_tools_flattened_builtin_and_nameless_dropped",
                json!({
                    "model": "m", "input": "x",
                    "tools": [
                        {"type": "function", "name": "shell", "description": "run a shell command",
                         "parameters": {"type": "object", "properties": {"cmd": {"type": "string"}}},
                         "strict": true},
                        {"type": "function", "name": "bare"},
                        {"type": "web_search_preview"},
                        {"type": "function", "description": "no name"}
                    ]
                }),
            ),
            req(
                "request_tools_all_dropped_omits_key",
                json!({
                    "model": "m", "input": "x", "tools": [{"type": "web_search"}]
                }),
            ),
            req(
                "request_tool_choice_string_passthrough",
                json!({
                    "model": "m", "input": "x", "tool_choice": "required"
                }),
            ),
            req(
                "request_tool_choice_named_function_wrapped",
                json!({
                    "model": "m", "input": "x", "tool_choice": {"type": "function", "name": "shell"}
                }),
            ),
            req(
                "request_tool_choice_object_without_name_passthrough",
                json!({
                    "model": "m", "input": "x",
                    "tool_choice": {"type": "allowed_tools", "mode": "auto", "tools": []}
                }),
            ),
            req(
                "request_tool_choice_null_defaults_auto",
                json!({
                    "model": "m", "input": "x", "tool_choice": null
                }),
            ),
            // ── request: scalar knobs / unknown fields ─────────────────────
            req(
                "request_knobs_mapped_unknown_fields_dropped",
                json!({
                    "model": "m", "input": "x",
                    "temperature": 0.2, "top_p": 0.9, "max_output_tokens": 256,
                    "parallel_tool_calls": false,
                    "store": false, "include": ["reasoning.encrypted_content"],
                    "metadata": {"k": "v"}, "reasoning": {"effort": "high"},
                    "previous_response_id": "resp_prev", "prompt_cache_key": "pk", "user": "u1"
                }),
            ),
            req("request_model_missing_omitted", json!({"input": "x"})),
            // ── request: text.format ───────────────────────────────────────
            req(
                "request_text_format_json_schema",
                json!({
                    "model": "m", "input": "x",
                    "text": {"format": {"type": "json_schema", "name": "answer",
                                        "schema": {"type": "object", "properties": {"a": {"type": "integer"}}},
                                        "strict": true}}
                }),
            ),
            req(
                "request_text_format_json_schema_partial",
                json!({
                    "model": "m", "input": "x", "text": {"format": {"type": "json_schema"}}
                }),
            ),
            req(
                "request_text_format_json_object",
                json!({
                    "model": "m", "input": "x", "text": {"format": {"type": "json_object"}, "verbosity": "low"}
                }),
            ),
            req(
                "request_text_format_text_ignored",
                json!({
                    "model": "m", "input": "x", "text": {"format": {"type": "text"}}
                }),
            ),
            // ── non-streaming response ─────────────────────────────────────
            resp(
                "response_text_only_with_usage",
                json!({
                    "model": "m", "created": 1700000000,
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": "hi there"},
                                 "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7}
                }),
            ),
            resp(
                "response_tool_calls_only_null_content_no_usage",
                json!({
                    "choices": [{"message": {
                        "role": "assistant", "content": null,
                        "tool_calls": [{"id": "call_9", "type": "function",
                                        "function": {"name": "shell", "arguments": "{\"cmd\":\"ls\"}"}}]
                    }, "finish_reason": "tool_calls"}]
                }),
            ),
            resp(
                "response_text_and_two_tool_calls_ordered",
                json!({
                    "model": "m", "created": 1,
                    "choices": [{"message": {
                        "role": "assistant", "content": "calling",
                        "tool_calls": [
                            {"id": "call_a", "type": "function", "function": {"name": "a", "arguments": "{}"}},
                            {"id": "call_b", "type": "function", "function": {"name": "b", "arguments": "{\"x\":1}"}}
                        ]
                    }, "finish_reason": "tool_calls"}],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 2}
                }),
            ),
            resp(
                "response_empty_content_no_message_item",
                json!({
                    "model": "m", "choices": [{"message": {"role": "assistant", "content": ""}}]
                }),
            ),
            resp(
                "response_content_array_not_string_ignored",
                json!({
                    "model": "m",
                    "choices": [{"message": {"role": "assistant",
                                             "content": [{"type": "text", "text": "x"}]}}]
                }),
            ),
            resp("response_empty_object", json!({})),
            resp(
                "response_multiple_choices_only_first_used",
                json!({
                    "model": "m",
                    "choices": [{"message": {"role": "assistant", "content": "first"}},
                                {"message": {"role": "assistant", "content": "second"}}]
                }),
            ),
            resp(
                "response_usage_total_derived_when_missing",
                json!({
                    "model": "m", "choices": [{"message": {"content": "x"}}],
                    "usage": {"prompt_tokens": 3, "completion_tokens": 4}
                }),
            ),
            resp(
                "response_usage_non_integer_fields_zeroed",
                json!({
                    "model": "m", "choices": [{"message": {"content": "x"}}],
                    "usage": {"prompt_tokens": -1, "completion_tokens": 2.5, "total_tokens": "9"}
                }),
            ),
            resp(
                "response_usage_null_stays_null",
                json!({
                    "model": "m", "choices": [{"message": {"content": "x"}}], "usage": null
                }),
            ),
            resp(
                "response_tool_call_missing_fields_default_empty",
                json!({
                    "model": "m",
                    "choices": [{"message": {"content": null, "tool_calls": [{}, {"id": "call_1"}]}}]
                }),
            ),
            resp(
                "response_tool_call_name_non_string_cloned_verbatim",
                json!({
                    "model": "m",
                    "choices": [{"message": {"content": null,
                        "tool_calls": [{"id": "call_1", "function": {"name": 5, "arguments": {"not": "string"}}}]}}]
                }),
            ),
            resp(
                "response_finish_reason_length_still_completed",
                json!({
                    "model": "served-model", "created": 1700000000,
                    "choices": [{"message": {"content": "trunc"}, "finish_reason": "length"}],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
                }),
            ),
            // ── streaming ──────────────────────────────────────────────────
            stream(
                "stream_text_sequence_with_usage",
                vec![
                    json!({"choices":[{"delta":{"role":"assistant"}}]}),
                    json!({"choices":[{"delta":{"content":"He"}}]}),
                    json!({"choices":[{"delta":{"content":"llo"}}]}),
                    json!({"choices":[{"delta":{},"finish_reason":"stop"}],
                       "usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}),
                ],
            ),
            stream(
                "stream_tool_call_sequence",
                vec![
                    json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1",
                    "type":"function","function":{"name":"shell","arguments":"{\"cmd"}}]}}]}),
                    json!({"choices":[{"delta":{"tool_calls":[{"index":0,
                    "function":{"arguments":"\":\"ls\"}"}}]}}]}),
                    json!({"choices":[{"delta":{},"finish_reason":"tool_calls"}]}),
                ],
            ),
            stream(
                "stream_text_then_tool_call",
                vec![
                    json!({"choices":[{"delta":{"content":"let me "}}]}),
                    json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1",
                    "function":{"name":"shell","arguments":"{}"}}]}}]}),
                    json!({"choices":[{"delta":{},"finish_reason":"tool_calls"}]}),
                ],
            ),
            stream(
                "stream_tool_call_then_text_output_sorted_by_index",
                vec![
                    json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1",
                    "function":{"name":"shell","arguments":"{}"}}]}}]}),
                    json!({"choices":[{"delta":{"content":"done"}}]}),
                    json!({"choices":[{"delta":{},"finish_reason":"stop"}]}),
                ],
            ),
            stream(
                "stream_two_tool_calls_interleaved_args",
                vec![
                    json!({"choices":[{"delta":{"tool_calls":[
                    {"index":0,"id":"call_a","function":{"name":"a","arguments":"{\"x\":"}},
                    {"index":1,"id":"call_b","function":{"name":"b","arguments":"{\"y\":"}}]}}]}),
                    json!({"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"2}"}}]}}]}),
                    json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}),
                    json!({"choices":[{"delta":{},"finish_reason":"tool_calls"}]}),
                ],
            ),
            stream(
                "stream_tool_call_name_split_across_chunks_concatenated",
                vec![
                    json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"she"}}]}}]}),
                    json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"ll","arguments":"{}"}}]}}]}),
                ],
            ),
            stream(
                "stream_tool_call_id_last_nonempty_wins_added_keeps_first",
                vec![
                    json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"","function":{"name":"shell"}}]}}]}),
                    json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_late","function":{"arguments":"{}"}}]}}]}),
                ],
            ),
            stream(
                "stream_tool_call_missing_index_defaults_zero",
                vec![
                    json!({"choices":[{"delta":{"tool_calls":[{"id":"call_1","function":{"name":"a","arguments":"{"}}]}}]}),
                    json!({"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"}"}}]}}]}),
                ],
            ),
            stream(
                "stream_tool_call_args_before_name",
                vec![
                    json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"a\""}}]}}]}),
                    json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"late","arguments":":1}"}}]}}]}),
                ],
            ),
            stream(
                "stream_empty_and_null_content_deltas_ignored",
                vec![
                    json!({"choices":[{"delta":{"content":""}}]}),
                    json!({"choices":[{"delta":{"content":null}}]}),
                    json!({"choices":[{"delta":{"content":"x"}}]}),
                ],
            ),
            stream(
                "stream_reasoning_content_delta_dropped",
                vec![
                    json!({"choices":[{"delta":{"reasoning_content":"thinking..."}}]}),
                    json!({"choices":[{"delta":{"content":"answer"}}]}),
                ],
            ),
            stream(
                "stream_error_object_mid_stream_not_translated",
                vec![
                    json!({"choices":[{"delta":{"content":"par"}}]}),
                    json!({"error":{"message":"boom","type":"server_error","code":500}}),
                ],
            ),
            stream(
                "stream_chunks_without_usable_choice_ignored",
                vec![
                    json!({"choices":[]}),
                    json!({"choices":[{"finish_reason":"stop"}]}),
                    json!({"choices":"nope"}),
                    json!({"choices":[{"delta":{"content":"ok"}}]}),
                ],
            ),
            stream("stream_no_chunks_finish_only", vec![]),
            stream(
                "stream_usage_last_non_null_wins",
                vec![
                    json!({"choices":[{"delta":{"content":"a"}}],
                       "usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}),
                    json!({"choices":[{"delta":{"content":"b"}}],"usage":null}),
                ],
            ),
            stream(
                "stream_usage_total_derived_when_missing",
                vec![
                    json!({"choices":[{"delta":{"content":"a"}}]}),
                    json!({"choices":[{"delta":{},"finish_reason":"length"}],
                       "usage":{"prompt_tokens":10,"completion_tokens":20}}),
                ],
            ),
        ]
    }

    fn repo_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .canonicalize()
            .unwrap()
    }

    fn git_head(root: &PathBuf) -> String {
        std::process::Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(root)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_else(|| "unknown".to_string())
    }

    #[test]
    #[ignore]
    fn dump_fixtures() {
        let root = repo_root();
        let out = root.join("tests/fixtures/core-contracts/responses-shim");
        fs::create_dir_all(&out).unwrap();
        let commit = git_head(&root);
        let source = "src-tauri/src/core/server/responses_shim.rs";

        let mut names = Vec::new();
        for c in cases() {
            let mut norm = Normalizer::new();
            let (comparator, input, mut expected) = match c.kind {
                Kind::Request(body) => (
                    "json-exact",
                    json!({"kind": "request", "body": body}),
                    json!({"chat": responses_request_to_chat(&body)}),
                ),
                Kind::Response(chat) => (
                    "json-exact",
                    json!({"kind": "response", "chat": chat,
                           "response_id": RESPONSE_ID, "model_fallback": MODEL_FALLBACK}),
                    json!({"responses": chat_response_to_responses(&chat, RESPONSE_ID, MODEL_FALLBACK)}),
                ),
                Kind::Stream(chunks) => {
                    let mut conv = ResponsesStreamConverter::new(
                        RESPONSE_ID.to_string(),
                        STREAM_MODEL.to_string(),
                    );
                    let mut events = vec![conv.created_event()];
                    let mut usage: Option<Value> = None;
                    for chunk in &chunks {
                        if let Some(u) = chunk.get("usage") {
                            if !u.is_null() {
                                usage = Some(u.clone());
                            }
                        }
                        events.extend(conv.on_chunk(chunk));
                    }
                    events.extend(conv.finish(usage.as_ref()));
                    let sse: Vec<Value> = events
                        .into_iter()
                        .map(|ev| {
                            let event = ev
                                .get("type")
                                .and_then(|t| t.as_str())
                                .unwrap_or("message")
                                .to_string();
                            json!({"event": event, "data": ev})
                        })
                        .collect();
                    (
                        "sse-sequence",
                        json!({"kind": "stream", "response_id": RESPONSE_ID,
                               "model": STREAM_MODEL, "chunks": chunks}),
                        Value::Array(sse),
                    )
                }
            };
            norm.normalize(&mut expected);
            let doc = json!({
                "name": c.name,
                "source": { "file": source, "commit": commit },
                "comparator": comparator,
                "placeholders": norm.placeholders(),
                "input": input,
                "expected": expected,
            });
            fs::write(
                out.join(format!("{}.json", c.name)),
                serde_json::to_string_pretty(&doc).unwrap() + "\n",
            )
            .unwrap();
            names.push(c.name);
        }
        let index = json!({
            "source": { "file": source, "commit": commit },
            "comparators": ["json-exact", "sse-sequence"],
            "comparator_notes": {
                "json-exact": "input.kind=request: expected.chat = responses_request_to_chat(input.body). input.kind=response: expected.responses = chat_response_to_responses(input.chat, input.response_id, input.model_fallback). Compare the whole JSON tree exactly (key order irrelevant) AFTER applying the placeholder rule below to the port's output.",
                "sse-sequence": "input.kind=stream: harness = created_event(), then on_chunk(chunk) for each input.chunks entry in order, then finish(usage) where usage is the LAST non-null `usage` field seen on any chunk (the proxy's rule; [DONE] and a dropped upstream both lead to the same finish()). expected = ordered array of {event, data}; `event` is data.type (the proxy writes `event: <type>\\ndata: <json>\\n\\n`). Chunk boundaries are irrelevant; sequence_number must be contiguous from 0 across the whole sequence.",
                "placeholders": "Random item ids are replaced by placeholders numbered by first appearance within a case: msg_<32hex> -> <msg_id_N>, fc_<32hex> -> <fc_id_N>. Each case lists the placeholders it uses; the port must apply the same substitution to its own output before comparing. response_id is an input, never a placeholder."
            },
            "cases": names,
        });
        fs::write(
            out.join("index.json"),
            serde_json::to_string_pretty(&index).unwrap() + "\n",
        )
        .unwrap();
        eprintln!(
            "wrote {} responses-shim fixtures to {}",
            names.len(),
            out.display()
        );
    }
}
