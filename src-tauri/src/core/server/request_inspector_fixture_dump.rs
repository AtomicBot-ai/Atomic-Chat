//! Golden fixtures for the request inspector's pure parts (PLAN.md §4 stage 4d):
//! the prompt preview, stream telemetry folded into finish fields, the
//! `include_usage` injection and the trailer check.
//!
//! When the core serves the Local API it computes these itself and ships them to
//! the app in `api:request` events, so they must come out the same.
//!
//! Telemetry timing is replayed with explicit offsets: each frame is fed at
//! `start + offset_ms`, and `ttft_ms` is then exact rather than wall-clock.
//!
//! Run: `cargo test --lib -- --ignored server::request_inspector::fixture_dump --test-threads=1`.

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::*;

fn repo_root() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .canonicalize()
        .unwrap()
}

fn git_head(root: &std::path::Path) -> String {
    std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(root)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

const SOURCE: &str = "src-tauri/src/core/server/request_inspector.rs";

fn preview_cases() -> Vec<(String, Value, Value)> {
    let long = "ж".repeat(PREVIEW_MAX_CHARS + 5);
    let bodies = [
        ("preview_last_user_message", json!({"messages": [{"role": "system", "content": "s"}, {"role": "user", "content": "first"}, {"role": "assistant", "content": "a"}, {"role": "user", "content": "second"}]})),
        ("preview_parts_join_and_flag_images", json!({"messages": [{"role": "user", "content": [{"type": "text", "text": "what"}, {"type": "image_url", "image_url": {"url": "x"}}, {"type": "input_text", "text": "is"}, {"type": "output_text", "text": "this"}, {"text": "untyped"}]}]})),
        ("preview_responses_string_input", json!({"input": "plain"})),
        ("preview_responses_array_input", json!({"input": [{"role": "user", "content": [{"type": "input_text", "text": "hello"}]}]})),
        ("preview_truncated_on_char_boundary", json!({"messages": [{"role": "user", "content": long}]})),
        ("preview_no_messages", json!({"model": "x"})),
        ("preview_empty_messages", json!({"messages": []})),
        ("preview_system_only_falls_back_to_last", json!({"messages": [{"role": "system", "content": "only"}]})),
        ("preview_non_text_only", json!({"messages": [{"role": "user", "content": [{"type": "image_url"}]}]})),
        ("preview_content_null", json!({"messages": [{"role": "user", "content": null}]})),
        ("preview_messages_not_array_uses_input", json!({"messages": "x", "input": [{"role": "user", "content": "from input"}]})),
        ("preview_anthropic_blocks", json!({"messages": [{"role": "user", "content": [{"type": "text", "text": "hi"}, {"type": "tool_result", "content": "r"}]}]})),
        ("preview_empty_string_content", json!({"messages": [{"role": "user", "content": ""}]})),
    ];
    bodies
        .into_iter()
        .map(|(name, body)| {
            let p = prompt_preview(&body, PREVIEW_MAX_CHARS);
            (
                name.to_string(),
                json!({"kind": "prompt_preview", "body": body}),
                json!({"text": p.text, "chars": p.chars, "message_count": p.message_count, "has_non_text_parts": p.has_non_text_parts}),
            )
        })
        .collect()
}

fn telemetry_cases() -> Vec<(String, Value, Value)> {
    let delta = |t: &str| json!({"choices": [{"delta": {"content": t}, "finish_reason": null}]});
    let long_word = "x".repeat(PREVIEW_MAX_CHARS - 2);
    let sequences: Vec<(&str, Vec<(u64, Value)>, bool)> = vec![
        ("telemetry_openai_deltas_estimate_tokens", vec![(5, json!({"choices": [{"delta": {"role": "assistant"}}]})), (12, delta("Hel")), (15, delta("lo")), (20, json!({"choices": [{"delta": {}, "finish_reason": "stop"}]}))], false),
        ("telemetry_usage_trailer_is_authoritative", vec![(3, delta("a")), (4, delta("b")), (9, json!({"choices": [], "usage": {"prompt_tokens": 11, "completion_tokens": 22, "total_tokens": 33}}))], false),
        ("telemetry_null_usage_on_every_chunk_ignored", vec![(2, json!({"choices": [{"delta": {"content": "x"}}], "usage": null}))], false),
        ("telemetry_llamacpp_timings", vec![(7, json!({"choices": [{"delta": {"content": "t"}, "finish_reason": "length"}], "timings": {"prompt_n": 28, "predicted_n": 150, "prompt_per_second": 812.5, "predicted_per_second": 41.25}}))], false),
        ("telemetry_usage_counts_win_timings_rates_win", vec![(1, json!({"choices": [], "usage": {"prompt_tokens": 5, "completion_tokens": 6}, "timings": {"prompt_n": 99, "predicted_n": 99, "prompt_per_second": 0.0, "predicted_per_second": 12.0}}))], false),
        ("telemetry_total_summed_only_when_exact", vec![(1, json!({"choices": [], "usage": {"prompt_tokens": 5, "completion_tokens": 6}}))], false),
        ("telemetry_reasoning_only_previews_reasoning", vec![(4, json!({"choices": [{"delta": {"content": null}}]})), (6, json!({"choices": [{"delta": {"reasoning_content": "Think"}}]})), (8, json!({"choices": [{"delta": {"reasoning": "ing"}}]}))], false),
        ("telemetry_reply_wins_over_reasoning", vec![(4, json!({"choices": [{"delta": {"reasoning_details": [{"text": "why "}, {"text": "not"}]}}]})), (9, delta("answer"))], false),
        ("telemetry_first_reasoning_spelling_wins", vec![(4, json!({"choices": [{"delta": {"reasoning_content": "A", "reasoning": "B"}}]}))], false),
        ("telemetry_non_streaming_message", vec![(30, json!({"choices": [{"message": {"content": "whole", "reasoning_content": "hmm"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4}}))], true),
        ("telemetry_anthropic_events", vec![(1, json!({"type": "message_start", "message": {"usage": {"input_tokens": 12}}})), (5, json!({"type": "content_block_delta", "delta": {"type": "text_delta", "text": "Hi"}})), (6, json!({"type": "content_block_delta", "delta": {"type": "thinking_delta", "thinking": "hm"}})), (9, json!({"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 3}}))], false),
        ("telemetry_preview_capped_across_deltas", vec![(1, delta(&long_word)), (2, delta("abcdef"))], false),
        ("telemetry_empty_content_is_not_a_token", vec![(1, delta("")), (2, json!({"choices": [{"delta": {"reasoning_content": ""}}]}))], false),
        ("telemetry_nothing_seen", vec![], false),
        ("telemetry_non_choice_json_ignored", vec![(1, json!({"object": "list"})), (2, json!([1, 2])), (3, json!("text"))], false),
    ];
    sequences
        .into_iter()
        .map(|(name, frames, whole)| {
            let start = Instant::now();
            let mut tel = StreamTelemetry::new();
            for (offset, frame) in &frames {
                tel.on_json(frame, start + Duration::from_millis(*offset));
            }
            if whole {
                tel.first_content_at = None;
            }
            let fields = tel.into_finish_fields(start);
            (
                name.to_string(),
                json!({
                    "kind": "stream_telemetry",
                    "frames": frames.iter().map(|(o, f)| json!({"offset_ms": o, "json": f})).collect::<Vec<_>>(),
                    "whole_response": whole,
                }),
                json!({
                    "ttft_ms": fields.ttft_ms,
                    "prompt_tokens": fields.prompt_tokens,
                    "completion_tokens": fields.completion_tokens,
                    "total_tokens": fields.total_tokens,
                    "tokens_estimated": fields.tokens_estimated,
                    "prompt_per_second": fields.prompt_per_second,
                    "predicted_per_second": fields.predicted_per_second,
                    "finish_reason": fields.finish_reason,
                    "reply_preview": fields.reply_preview,
                    "reply_chars": fields.reply_chars,
                }),
            )
        })
        .collect()
}

fn usage_cases() -> Vec<(String, Value, Value)> {
    let bodies = [
        ("inject_usage_when_not_asked", json!({"model": "m", "stream": true, "messages": []})),
        ("inject_usage_into_existing_options", json!({"stream": true, "stream_options": {"other": 1}})),
        ("inject_usage_client_choice_wins", json!({"stream": true, "stream_options": {"include_usage": false}})),
        ("inject_usage_not_streaming", json!({"stream": false})),
        ("inject_usage_stream_absent", json!({"model": "m"})),
        ("inject_usage_stream_truthy_string", json!({"stream": "true"})),
        ("inject_usage_options_not_object", json!({"stream": true, "stream_options": "nonsense"})),
        ("inject_usage_options_null", json!({"stream": true, "stream_options": null})),
        ("inject_usage_root_array", json!([1])),
    ];
    let mut out: Vec<(String, Value, Value)> = bodies
        .into_iter()
        .map(|(name, body)| {
            let bytes = Bytes::from(body.to_string());
            let rewritten = maybe_inject_stream_usage(&bytes)
                .map(|b| serde_json::from_slice::<Value>(&b).unwrap());
            (name.to_string(), json!({"kind": "maybe_inject_stream_usage", "body": body}), json!({"rewritten": rewritten}))
        })
        .collect();
    out.push((
        "inject_usage_invalid_json".to_string(),
        json!({"kind": "maybe_inject_stream_usage_raw", "raw": "{not json"}),
        json!({"rewritten": maybe_inject_stream_usage(&Bytes::from_static(b"{not json")).map(|_| true)}),
    ));
    for (name, chunk) in [
        ("usage_only_trailer", json!({"choices": [], "usage": {"prompt_tokens": 5}})),
        ("usage_only_null_usage", json!({"choices": [], "usage": null})),
        ("usage_only_normal_delta", json!({"choices": [{"delta": {"content": "hi"}}], "usage": {"prompt_tokens": 1}})),
        ("usage_only_no_choices_field", json!({"usage": {"prompt_tokens": 1}})),
    ] {
        out.push((name.to_string(), json!({"kind": "is_usage_only_chunk", "chunk": chunk}), json!({"trailer": is_usage_only_chunk(&chunk)})));
    }
    out
}

#[test]
#[ignore]
fn dump_fixtures() {
    let root = repo_root();
    let out = root.join("tests/fixtures/core-contracts/inspector-telemetry");
    let _ = std::fs::remove_dir_all(&out);
    std::fs::create_dir_all(&out).unwrap();
    let commit = git_head(&root);
    let mut names = Vec::new();
    let mut cases = preview_cases();
    cases.extend(telemetry_cases());
    cases.extend(usage_cases());
    for (name, input, expected) in cases {
        let doc = json!({"name": name, "source": {"file": SOURCE, "commit": commit}, "comparator": "json-exact", "input": input, "expected": expected});
        std::fs::write(out.join(format!("{name}.json")), serde_json::to_string_pretty(&doc).unwrap() + "\n").unwrap();
        names.push(name);
    }
    let index = json!({
        "source": {"file": SOURCE, "commit": commit},
        "comparators": ["json-exact"],
        "comparator_notes": {
            "json-exact": "Call the function named by input.kind and compare with expected as a JSON tree.",
            "stream_telemetry": "Feed each frame's json at start + offset_ms, in order; with whole_response the first-content time is cleared afterwards (a non-streamed reply has no time to first token); expected is the finish fields the telemetry folds into.",
            "constants": {"preview_max_chars": PREVIEW_MAX_CHARS, "log_capacity": LOG_CAPACITY, "progress_interval_ms": 1000, "progress_inflight_ceiling": 64},
            "privacy": "prompt_preview and reply_preview are user content: in the app they travel only on api-inspector:// channels and live only in memory (ATO-113)."
        },
        "cases": names,
    });
    std::fs::write(out.join("index.json"), serde_json::to_string_pretty(&index).unwrap() + "\n").unwrap();
}
