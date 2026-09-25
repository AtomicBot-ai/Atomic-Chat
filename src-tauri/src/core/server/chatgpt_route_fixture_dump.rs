//! Golden fixtures for the ChatGPT subscription route (PLAN.md §4 stage 4c).
//!
//! Captures the two deterministic halves of `chatgpt_route.rs`: the exact
//! upstream request built for a chat completion (method, URL, headers, body),
//! and how an item of the `/codex/models` list is normalised for the picker.
//! The exchange itself goes to the pinned `https://chatgpt.com/backend-api/codex`
//! and is not captured; its response side is `ChatChunkStreamConverter`, already
//! pinned by the `chat-to-responses-shim` set.
//!
//! A child module so the private `build_upstream_request` and `normalize_model`
//! can be driven as they are.
//!
//! Run: `cargo test --lib -- --ignored server::chatgpt_route::fixture_dump --test-threads=1`.

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

const SOURCE: &str = "src-tauri/src/core/server/chatgpt_route.rs";

fn request_cases() -> Vec<(String, Value, Value)> {
    let client = Client::new();
    let bodies = [
        (
            "upstream_request_simple_chat",
            json!({"model": "gpt-5", "messages": [{"role": "user", "content": "hi"}]}),
            Some("acct_1"),
        ),
        (
            "upstream_request_without_account",
            json!({"model": "gpt-5", "stream": true, "messages": [{"role": "system", "content": "be brief"}, {"role": "user", "content": "hi"}]}),
            None,
        ),
        (
            "upstream_request_with_tools_and_reasoning",
            json!({
                "model": "gpt-5-codex",
                "reasoning_effort": "high",
                "tools": [{"type": "function", "function": {"name": "lookup", "description": "d", "parameters": {"type": "object", "properties": {"q": {"type": "string"}}}}}],
                "tool_choice": "auto",
                "messages": [{"role": "user", "content": "find"}]
            }),
            Some("acct_2"),
        ),
    ];
    bodies
        .into_iter()
        .map(|(name, body, account)| {
            let session_id = "11111111-2222-3333-4444-555555555555";
            let request_id = "0123456789abcdef0123456789abcdef";
            let payload = crate::core::server::chat_to_responses_shim::chat_request_to_responses(&body, session_id);
            let request = build_upstream_request(&client, "access-token-xyz", account, session_id, request_id, &payload)
                .build()
                .expect("request builds");
            let mut headers: Vec<(String, String)> = request
                .headers()
                .iter()
                .map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string()))
                .collect();
            headers.sort();
            let sent_body: Value = request
                .body()
                .and_then(|b| b.as_bytes())
                .map(|bytes| serde_json::from_slice(bytes).unwrap())
                .unwrap_or(Value::Null);
            (
                name.to_string(),
                json!({
                    "kind": "upstream_request",
                    "chat_body": body,
                    "access_token": "access-token-xyz",
                    "account_id": account,
                    "session_id": session_id,
                    "request_id": request_id,
                }),
                json!({
                    "method": request.method().as_str(),
                    "url": request.url().as_str(),
                    "headers": headers.into_iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>(),
                    "body": sent_body,
                }),
            )
        })
        .collect()
}

fn model_cases() -> Vec<(String, Value, Value)> {
    let items = [
        ("model_full_entry", json!({"slug": "gpt-5", "display_name": "GPT-5", "context_window": 272000, "input_modalities": ["text", "image"], "supported_reasoning_levels": [{"effort": "low"}, {"effort": "high"}], "visibility": "list"})),
        ("model_minimal_entry", json!({"slug": "gpt-5-mini"})),
        ("model_empty_display_name_falls_back_to_slug", json!({"slug": "codex", "display_name": ""})),
        ("model_hidden_visibility_not_listed", json!({"slug": "internal", "visibility": "hide"})),
        ("model_boolean_context_window_ignored", json!({"slug": "x", "context_window": true})),
        ("model_negative_context_window_ignored", json!({"slug": "x", "context_window": -1})),
        ("model_text_only_modalities", json!({"slug": "x", "input_modalities": ["text"]})),
        ("model_reasoning_levels_without_effort_skipped", json!({"slug": "x", "supported_reasoning_levels": [{"description": "?"}, {"effort": 3}, {"effort": "medium"}]})),
        ("model_missing_slug_dropped", json!({"display_name": "No slug"})),
        ("model_empty_slug_dropped", json!({"slug": ""})),
        ("model_non_string_slug_dropped", json!({"slug": 42})),
        ("model_slug_at_length_limit_kept", json!({"slug": "a".repeat(128)})),
        ("model_slug_over_length_limit_dropped", json!({"slug": "a".repeat(129)})),
    ];
    items
        .into_iter()
        .map(|(name, item)| {
            let normalized = normalize_model(&item).map(|m| serde_json::to_value(m).unwrap());
            (name.to_string(), json!({"kind": "normalize_model", "item": item}), json!({"model": normalized}))
        })
        .chain(
            [
                ("subscription_provider_chatgpt", Some("chatgpt")),
                ("subscription_provider_other", Some("openai")),
                ("subscription_provider_none", None),
            ]
            .into_iter()
            .map(|(name, provider)| {
                (
                    name.to_string(),
                    json!({"kind": "is_subscription_model", "provider": provider}),
                    json!({"subscription": is_subscription_model(provider)}),
                )
            }),
        )
        .collect()
}

#[test]
#[ignore]
fn dump_fixtures() {
    let root = repo_root();
    let out = root.join("tests/fixtures/core-contracts/chatgpt-route");
    let _ = std::fs::remove_dir_all(&out);
    std::fs::create_dir_all(&out).unwrap();
    let commit = git_head(&root);

    let mut cases = request_cases();
    cases.extend(model_cases());
    let mut names = Vec::new();
    for (name, input, expected) in cases {
        let doc = json!({
            "name": name,
            "source": {"file": SOURCE, "commit": commit},
            "comparator": "json-exact",
            "input": input,
            "expected": expected,
        });
        std::fs::write(out.join(format!("{name}.json")), serde_json::to_string_pretty(&doc).unwrap() + "\n").unwrap();
        names.push(name);
    }
    let index = json!({
        "source": {"file": SOURCE, "commit": commit},
        "comparators": ["json-exact"],
        "comparator_notes": {
            "json-exact": "Call the function named by input.kind and compare with expected as a JSON tree.",
            "upstream_request": "input.chat_body goes through chat_request_to_responses(body, session_id) and the result is the request body; expected.headers are every header reqwest would send before connection-level ones (sorted by name), expected.url is the exact URL.",
            "normalize_model": "expected.model is the normalised picker entry, or null when the item is dropped.",
            "constants": {
                "provider": CHATGPT_PROVIDER,
                "base_url": CHATGPT_BASE_URL,
                "originator": ORIGINATOR,
                "user_agent": USER_AGENT,
                "client_version": CLIENT_VERSION,
                "request_timeout_secs": REQUEST_TIMEOUT.as_secs(),
            },
            "behaviour_not_captured": "respond(): one forced token refresh on an upstream 401 then retry; no session → 401 with the auth error text; transport failure → 502 `ChatGPT subscription request failed: <error>`; non-2xx → the upstream status and body verbatim; stream=false → the stream is aggregated into one chat.completion (converter error → 502 with its message); stream=true → `data: <chunk>` frames, then the converter's finish chunks and `data: [DONE]` whatever ended the stream; session_id is a fresh UUID per request and doubles as prompt_cache_key; x-client-request-id is a fresh simple UUID. list_models(): GET <base>/models?client_version=…, one forced refresh on 401, non-2xx → `Could not list ChatGPT models (<status>): <body>`, first occurrence of a slug wins."
        },
        "cases": names,
    });
    std::fs::write(out.join("index.json"), serde_json::to_string_pretty(&index).unwrap() + "\n").unwrap();
    eprintln!("wrote {} chatgpt-route fixtures", names.len());
}
