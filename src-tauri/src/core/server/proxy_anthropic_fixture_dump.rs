//! Golden fixtures for the Anthropic `/messages` ↔ OpenAI Chat Completions
//! conversion in `proxy.rs`, for the `atomic-chat-core` port (PLAN.md §4 stage 4a).
//!
//! Lives inside `proxy.rs` as a child module so it can drive the private
//! transforms directly; nothing here runs in a normal test pass.
//!
//! Run: `cargo test --lib -- --ignored server::proxy::anthropic_fixture_dump`.

use super::*;
use hyper::body::Bytes;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

enum Kind {
    /// `transform_anthropic_to_openai(body)`; `None` is recorded as `null`.
    Request(Value),
    /// `transform_openai_response_to_anthropic(chat)`.
    Response(Value),
    /// `transform_and_forward_stream` fed these network chunks, in order.
    Stream(Vec<&'static str>),
}

struct Case {
    name: &'static str,
    kind: Kind,
}

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

fn stream(name: &'static str, chunks: Vec<&'static str>) -> Case {
    Case {
        name,
        kind: Kind::Stream(chunks),
    }
}

fn cases() -> Vec<Case> {
    vec![
        // ── request: required fields ──────────────────────────────────────
        req(
            "request_minimal_string_content",
            json!({"model": "m", "messages": [{"role": "user", "content": "hi"}]}),
        ),
        req("request_missing_model_is_none", json!({"messages": []})),
        req("request_missing_messages_is_none", json!({"model": "m"})),
        req(
            "request_message_without_role_is_none",
            json!({"model": "m", "messages": [{"content": "hi"}]}),
        ),
        req(
            "request_content_neither_string_nor_array_is_none",
            json!({"model": "m", "messages": [{"role": "user", "content": 42}]}),
        ),
        req(
            "request_unknown_role_string_content_skipped",
            json!({"model": "m", "messages": [
                {"role": "narrator", "content": "x"},
                {"role": "user", "content": "hi"}
            ]}),
        ),
        req(
            "request_stream_true_passed_through",
            json!({"model": "m", "stream": true, "messages": [{"role": "user", "content": "hi"}]}),
        ),
        // ── request: system prompt ────────────────────────────────────────
        req(
            "request_system_string",
            json!({"model": "m", "system": "be terse", "messages": [{"role": "user", "content": "hi"}]}),
        ),
        req(
            "request_system_blocks_joined_with_newline",
            json!({"model": "m", "system": [
                {"type": "text", "text": "a"},
                {"type": "text", "text": "b", "cache_control": {"type": "ephemeral"}}
            ], "messages": [{"role": "user", "content": "hi"}]}),
        ),
        req(
            "request_system_blocks_all_empty_dropped",
            json!({"model": "m", "system": [{"type": "text", "text": ""}], "messages": [{"role": "user", "content": "hi"}]}),
        ),
        req(
            "request_system_and_developer_messages_merged_into_one_leading_system",
            json!({"model": "m", "system": "sys", "messages": [
                {"role": "user", "content": "hi"},
                {"role": "developer", "content": [{"type": "text", "text": "dev"}]},
                {"role": "system", "content": "late"}
            ]}),
        ),
        // ── request: user blocks ──────────────────────────────────────────
        req(
            "request_user_single_text_block_becomes_string",
            json!({"model": "m", "messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}]}]}),
        ),
        req(
            "request_user_text_and_image_become_parts",
            json!({"model": "m", "messages": [{"role": "user", "content": [
                {"type": "text", "text": "look"},
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"}}
            ]}]}),
        ),
        req(
            "request_user_image_media_type_on_block_fallback",
            json!({"model": "m", "messages": [{"role": "user", "content": [
                {"type": "image", "media_type": "image/jpeg", "source": {"type": "base64", "data": "BBBB"}}
            ]}]}),
        ),
        req(
            "request_user_image_without_data_dropped",
            json!({"model": "m", "messages": [{"role": "user", "content": [
                {"type": "image", "source": {"type": "url", "url": "https://x/y.png"}},
                {"type": "text", "text": "hi"}
            ]}]}),
        ),
        req(
            "request_user_unknown_block_with_text_kept",
            json!({"model": "m", "messages": [{"role": "user", "content": [
                {"type": "document", "text": "doc body"}
            ]}]}),
        ),
        req(
            "request_user_tool_results_come_before_user_text",
            json!({"model": "m", "messages": [{"role": "user", "content": [
                {"type": "text", "text": "and then"},
                {"type": "tool_result", "tool_use_id": "toolu_1", "content": "42"},
                {"type": "tool_result", "tool_use_id": "toolu_2", "content": [
                    {"type": "text", "text": "a"}, {"type": "image", "source": {}}, {"type": "text", "text": "b"}
                ]}
            ]}]}),
        ),
        req(
            "request_user_tool_result_content_object_and_missing",
            json!({"model": "m", "messages": [{"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "t1", "content": {"k": 1, "a": [true]}},
                {"type": "tool_result", "content": null},
                {"type": "tool_result"}
            ]}]}),
        ),
        req(
            "request_user_only_tool_results_emits_no_user_message",
            json!({"model": "m", "messages": [{"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "t1", "content": "ok"}
            ]}]}),
        ),
        req(
            "request_user_empty_array_emits_nothing",
            json!({"model": "m", "messages": [{"role": "user", "content": []}]}),
        ),
        // ── request: assistant blocks ─────────────────────────────────────
        req(
            "request_assistant_text_only",
            json!({"model": "m", "messages": [{"role": "assistant", "content": [{"type": "text", "text": "ok"}]}]}),
        ),
        req(
            "request_assistant_tool_use_without_text_has_null_content",
            json!({"model": "m", "messages": [{"role": "assistant", "content": [
                {"type": "tool_use", "id": "toolu_1", "name": "get", "input": {"z": 1, "a": {"y": 2, "b": [3]}}}
            ]}]}),
        ),
        req(
            "request_assistant_text_and_two_tool_uses",
            json!({"model": "m", "messages": [{"role": "assistant", "content": [
                {"type": "text", "text": "calling"},
                {"type": "tool_use", "id": "t1", "name": "a", "input": {}},
                {"type": "tool_use", "id": "t2", "name": "b", "input": {"q": "x"}}
            ]}]}),
        ),
        req(
            "request_assistant_tool_use_missing_input_skipped",
            json!({"model": "m", "messages": [{"role": "assistant", "content": [
                {"type": "tool_use", "id": "t1", "name": "a"},
                {"type": "text", "text": "hi"}
            ]}]}),
        ),
        req(
            "request_assistant_empty_array_content_is_empty_string",
            json!({"model": "m", "messages": [{"role": "assistant", "content": []}]}),
        ),
        req(
            "request_assistant_text_and_image_become_parts",
            json!({"model": "m", "messages": [{"role": "assistant", "content": [
                {"type": "text", "text": "a"}, {"type": "text", "text": "b"}
            ]}]}),
        ),
        // ── request: tools and parameters ─────────────────────────────────
        req(
            "request_tools_mapped_and_nameless_dropped",
            json!({"model": "m", "messages": [], "tools": [
                {"name": "get", "description": "d", "input_schema": {"type": "object"}},
                {"name": "bare"},
                {"description": "no name"}
            ]}),
        ),
        req(
            "request_tools_all_invalid_omits_field",
            json!({"model": "m", "messages": [], "tools": [{"description": "x"}]}),
        ),
        req(
            "request_passthrough_params_and_stop_sequences",
            json!({"model": "m", "messages": [], "temperature": 0.2, "top_p": 0.9, "top_k": 40,
                   "frequency_penalty": 0.1, "presence_penalty": 0.3, "stop_sequences": ["END"],
                   "max_tokens": 1024, "metadata": {"user_id": "u"}}),
        ),
        // ── response ──────────────────────────────────────────────────────
        resp(
            "response_text_stop",
            json!({"id": "chatcmpl-1", "model": "m", "choices": [
                {"index": 0, "message": {"role": "assistant", "content": "hello"}, "finish_reason": "stop"}
            ], "usage": {"prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4}}),
        ),
        resp(
            "response_tool_calls_with_text",
            json!({"id": "c", "model": "m", "choices": [{"message": {
                "content": "calling",
                "tool_calls": [
                    {"id": "call_1", "type": "function", "function": {"name": "get", "arguments": "{\"b\":1,\"a\":2}"}},
                    {"id": "call_2", "type": "function", "function": {"name": "bad", "arguments": "not json"}},
                    {"type": "function", "function": {}}
                ]
            }, "finish_reason": "tool_calls"}]}),
        ),
        resp(
            "response_length_maps_to_max_tokens_and_empty_text_dropped",
            json!({"choices": [{"message": {"content": ""}, "finish_reason": "length"}]}),
        ),
        resp(
            "response_null_content_and_unknown_finish_reason_passed_through",
            json!({"id": "x", "choices": [{"message": {"content": null}, "finish_reason": "content_filter"}]}),
        ),
        resp("response_no_choices", json!({"id": "x", "model": "m"})),
        // ── stream ────────────────────────────────────────────────────────
        stream(
            "stream_text_then_done",
            vec![
                "data: {\"id\":\"c1\",\"model\":\"m\",\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"\"},\"finish_reason\":null}]}\n\n",
                "data: {\"id\":\"c1\",\"model\":\"m\",\"choices\":[{\"delta\":{\"content\":\"hello \"},\"finish_reason\":null}]}\n\n",
                "data: {\"id\":\"c1\",\"model\":\"m\",\"choices\":[{\"delta\":{\"content\":\"big world\"},\"finish_reason\":null}]}\n\n",
                "data: [DONE]\n\n",
            ],
        ),
        stream(
            "stream_text_with_finish_reason_stops_before_done",
            vec![
                "data: {\"id\":\"c1\",\"model\":\"m\",\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":null}]}\n\n",
                "data: {\"id\":\"c1\",\"model\":\"m\",\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\n",
                "data: {\"id\":\"c1\",\"model\":\"m\",\"choices\":[{\"delta\":{\"content\":\"ignored\"},\"finish_reason\":null}]}\n\n",
                "data: [DONE]\n\n",
            ],
        ),
        stream(
            "stream_text_then_tool_call_closes_text_block",
            vec![
                "data: {\"id\":\"c2\",\"model\":\"m\",\"choices\":[{\"delta\":{\"content\":\"let me check\"},\"finish_reason\":null}]}\n\n",
                "data: {\"id\":\"c2\",\"model\":\"m\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_a\",\"function\":{\"name\":\"get\",\"arguments\":\"\"}}]},\"finish_reason\":null}]}\n\n",
                "data: {\"id\":\"c2\",\"model\":\"m\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"q\\\":\"}}]},\"finish_reason\":null}]}\n\n",
                "data: {\"id\":\"c2\",\"model\":\"m\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"1}\"}}]},\"finish_reason\":null}]}\n\n",
                "data: {\"id\":\"c2\",\"model\":\"m\",\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
            ],
        ),
        stream(
            "stream_two_parallel_tool_calls_then_done",
            vec![
                "data: {\"id\":\"c3\",\"model\":\"m\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_a\",\"function\":{\"name\":\"a\",\"arguments\":\"{}\"}},{\"index\":1,\"id\":\"call_b\",\"function\":{\"name\":\"b\",\"arguments\":\"\"}}]},\"finish_reason\":null}]}\n\n",
                "data: {\"id\":\"c3\",\"model\":\"m\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":1,\"function\":{\"arguments\":\"{\\\"x\\\":2}\"}}]},\"finish_reason\":null}]}\n\n",
                "data: [DONE]\n\n",
            ],
        ),
        stream(
            "stream_several_events_in_one_network_chunk",
            vec![
                "data: {\"id\":\"c4\",\"model\":\"m\",\"choices\":[{\"delta\":{\"content\":\"a\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"c4\",\"model\":\"m\",\"choices\":[{\"delta\":{\"content\":\"b\"},\"finish_reason\":\"stop\"}]}\n\n",
            ],
        ),
        stream(
            "stream_ignores_comments_invalid_json_and_chunks_without_delta",
            vec![
                ": keep-alive\n\n",
                "data: not json\n\n",
                "data: {\"id\":\"c5\",\"choices\":[]}\n\n",
                "event: ping\ndata: {\"id\":\"c5\",\"model\":\"m\",\"choices\":[{\"delta\":{\"content\":\"x\"},\"finish_reason\":null}]}\n\n",
                "data: [DONE]\n\n",
            ],
        ),
        stream(
            "stream_ends_without_done_or_finish_emits_no_closing_events",
            vec![
                "data: {\"id\":\"c6\",\"model\":\"m\",\"choices\":[{\"delta\":{\"content\":\"partial\"},\"finish_reason\":null}]}\n\n",
            ],
        ),
        stream("stream_done_only", vec!["data: [DONE]\n\n"]),
        // Known Rust defect, recorded on purpose: each network chunk is split
        // into lines independently, so a `data:` line cut across two chunks is
        // parsed as two invalid halves and dropped. See the index note.
        stream(
            "stream_data_line_split_across_network_chunks",
            vec![
                "data: {\"id\":\"c7\",\"model\":\"m\",\"choices\":[{\"delta\":{\"content\":\"kept\"},\"finish_reason\":null}]}\n\n",
                "data: {\"id\":\"c7\",\"model\":\"m\",\"choices\":[{\"delta\":{\"con",
                "tent\":\"lost\"},\"finish_reason\":null}]}\n\n",
                "data: [DONE]\n\n",
            ],
        ),
    ]
}

/// Drive the real stream transform with the given network chunks and parse
/// what it wrote back into `{event, data}` pairs.
async fn run_stream(chunks: &[&'static str]) -> Value {
    let (sender, body) = hyper::Body::channel();
    let items: Vec<Result<Bytes, reqwest::Error>> = chunks
        .iter()
        .map(|c| Ok(Bytes::from_static(c.as_bytes())))
        .collect();
    let upstream = futures_util::stream::iter(items);
    let task = tokio::spawn(async move {
        transform_and_forward_stream(upstream, sender, "/messages").await;
    });
    let bytes = hyper::body::to_bytes(body).await.expect("collect body");
    task.await.expect("transform task");
    let text = String::from_utf8(bytes.to_vec()).expect("utf8");
    let mut events = Vec::new();
    for frame in text.split("\n\n").filter(|f| !f.trim().is_empty()) {
        let mut event = None;
        let mut data = None;
        for line in frame.lines() {
            if let Some(rest) = line.strip_prefix("event: ") {
                event = Some(rest.to_string());
            } else if let Some(rest) = line.strip_prefix("data: ") {
                data = Some(serde_json::from_str::<Value>(rest).expect("data json"));
            }
        }
        events.push(json!({"event": event, "data": data}));
    }
    Value::Array(events)
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

#[tokio::test]
#[ignore]
async fn dump_fixtures() {
    let root = repo_root();
    let out = root.join("tests/fixtures/core-contracts/anthropic-shim");
    fs::create_dir_all(&out).unwrap();
    let commit = git_head(&root);
    let source = "src-tauri/src/core/server/proxy.rs";

    let mut names = Vec::new();
    for c in cases() {
        let (comparator, input, expected) = match c.kind {
            Kind::Request(body) => (
                "json-exact",
                json!({"kind": "request", "body": body}),
                json!({"chat": transform_anthropic_to_openai(&body)}),
            ),
            Kind::Response(chat) => (
                "json-exact",
                json!({"kind": "response", "chat": chat}),
                json!({"anthropic": transform_openai_response_to_anthropic(&chat)}),
            ),
            Kind::Stream(chunks) => (
                "sse-sequence",
                json!({"kind": "stream", "chunks": chunks}),
                run_stream(&chunks).await,
            ),
        };
        let doc = json!({
            "name": c.name,
            "source": { "file": source, "commit": commit },
            "comparator": comparator,
            "placeholders": [],
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
            "json-exact": "input.kind=request: expected.chat = transform_anthropic_to_openai(input.body), null when the Rust returns None (missing model/messages, a message without role, content that is neither string nor array). input.kind=response: expected.anthropic = transform_openai_response_to_anthropic(input.chat). tool_use `input` objects are serialised into `arguments` with serde_json's compact writer, whose object keys are sorted. Compare the whole tree exactly.",
            "sse-sequence": "input.kind=stream: transform_and_forward_stream fed input.chunks as consecutive network reads. expected = ordered {event, data} pairs; the proxy writes `event: <data.type>\\ndata: <json>\\n\\n`. output_tokens in message_delta is the whitespace-separated word count of the streamed text, not a token count.",
            "known_divergence": "stream_data_line_split_across_network_chunks records a Rust defect: each network read is split into lines on its own, so a `data:` line cut across two reads is parsed as two invalid halves and silently dropped. The port buffers lines across reads and delivers the text; that single case is expected to differ and is listed as such by the replay harness."
        },
        "cases": names,
    });
    fs::write(
        out.join("index.json"),
        serde_json::to_string_pretty(&index).unwrap() + "\n",
    )
    .unwrap();
    eprintln!(
        "wrote {} anthropic-shim fixtures to {}",
        names.len(),
        out.display()
    );
}
