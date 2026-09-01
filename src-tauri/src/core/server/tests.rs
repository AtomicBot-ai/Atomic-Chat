#[cfg(test)]
mod tests {
    use crate::core::server::proxy;

    /// A streamed answer must not be cut off just because it is long — only
    /// because it stopped producing data. See `STREAM_IDLE_TIMEOUT`.
    mod stream_idle {
        use crate::core::server::proxy::{next_stream_chunk, StreamStep};
        use std::time::Duration;

        #[tokio::test]
        async fn a_chunk_that_arrives_in_time_is_forwarded() {
            let mut stream = futures_util::stream::iter(vec![1, 2, 3]);

            assert_eq!(
                next_stream_chunk(&mut stream, Duration::from_secs(30)).await,
                StreamStep::Chunk(1)
            );
        }

        #[tokio::test]
        async fn an_exhausted_stream_reports_done() {
            let mut stream = futures_util::stream::iter(Vec::<u8>::new());

            assert_eq!(
                next_stream_chunk(&mut stream, Duration::from_secs(30)).await,
                StreamStep::Done
            );
        }

        #[tokio::test]
        async fn a_silent_stream_gives_up_after_the_idle_window() {
            // Never yields: stands in for a backend that stopped responding.
            let mut stream = futures_util::stream::pending::<u8>();

            assert_eq!(
                next_stream_chunk(&mut stream, Duration::from_millis(20)).await,
                StreamStep::Idle
            );
        }

        #[tokio::test]
        async fn a_slow_but_live_stream_keeps_going() {
            // The regression being fixed: a generation slower than the old
            // whole-request deadline used to be killed mid-flight. Here each
            // chunk lands within the idle window, so the stream survives well
            // past the window's total length.
            let idle = Duration::from_millis(60);
            let mut stream = Box::pin(futures_util::stream::unfold(0u8, |n| async move {
                if n >= 5 {
                    return None;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
                Some((n, n + 1))
            }));

            let mut received = 0;
            while let StreamStep::Chunk(_) = next_stream_chunk(&mut stream, idle).await {
                received += 1;
            }

            assert_eq!(received, 5);
        }
    }

    #[test]
    fn test_get_destination_path_basic() {
        let result = proxy::get_destination_path("/v1/messages", "/v1");
        assert_eq!(result, "/messages");
    }

    #[test]
    fn test_get_destination_path_with_subpath() {
        let result = proxy::get_destination_path("/v1/messages/threads/123", "/v1");
        assert_eq!(result, "/messages/threads/123");
    }

    #[test]
    fn test_get_destination_path_no_prefix() {
        let result = proxy::get_destination_path("/messages", "");
        assert_eq!(result, "/messages");
    }

    #[test]
    fn test_get_destination_path_different_prefix() {
        let result = proxy::get_destination_path("/api/v1/messages", "/api/v1");
        assert_eq!(result, "/messages");
    }

    #[test]
    fn test_get_destination_path_empty_prefix() {
        let result = proxy::get_destination_path("/messages", "/v1");
        assert_eq!(result, "/messages");
    }

    #[test]
    fn test_messages_in_cors_whitelist() {
        let whitelisted_paths = ["/", "/openapi.json", "/messages"];
        assert!(whitelisted_paths.contains(&"/messages"));
    }

    #[test]
    fn test_messages_in_main_whitelist() {
        let whitelisted_paths = [
            "/",
            "/openapi.json",
            "/docs/swagger-ui.css",
            "/docs/swagger-ui-bundle.js",
            "/docs/swagger-ui-standalone-preset.js",
            "/messages",
        ];
        assert!(whitelisted_paths.contains(&"/messages"));
    }

    #[test]
    fn test_messages_subpath_not_in_exact_whitelist() {
        let whitelisted_paths = ["/", "/openapi.json", "/messages"];
        // Only exact match
        assert!(!whitelisted_paths.contains(&"/messages/threads"));
        assert!(!whitelisted_paths.contains(&"/messages/api"));
    }

    #[test]
    fn test_proxy_config_creation() {
        let config = proxy::ProxyConfig {
            prefix: "/v1".to_string(),
            proxy_api_key: "test-key".to_string(),
            trusted_hosts: vec![vec!["localhost".to_string()]],
            host: "localhost".to_string(),
            port: 1337,
        };
        assert_eq!(config.prefix, "/v1");
        assert_eq!(config.proxy_api_key, "test-key");
        assert_eq!(config.trusted_hosts.len(), 1);
        assert_eq!(config.host, "localhost");
        assert_eq!(config.port, 1337);
    }

    #[test]
    fn test_proxy_config_default() {
        let config = proxy::ProxyConfig {
            prefix: "".to_string(),
            proxy_api_key: "".to_string(),
            trusted_hosts: vec![],
            host: "127.0.0.1".to_string(),
            port: 8080,
        };
        assert_eq!(config.prefix, "");
        assert_eq!(config.proxy_api_key, "");
        assert_eq!(config.trusted_hosts.len(), 0);
        assert_eq!(config.host, "127.0.0.1");
        assert_eq!(config.port, 8080);
    }

    #[test]
    fn test_allowed_methods() {
        let allowed_methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"];
        assert!(allowed_methods.contains(&"POST"));
        assert!(allowed_methods.contains(&"GET"));
        assert!(allowed_methods.contains(&"OPTIONS"));
    }

    #[test]
    fn test_known_post_only_route_reports_post_allowlist() {
        let allowed = proxy::allowed_methods_for_path("/chat/completions");
        assert_eq!(allowed, Some(&["POST"][..]));
    }

    #[test]
    fn test_known_get_only_route_reports_get_allowlist() {
        let allowed = proxy::allowed_methods_for_path("/models");
        assert_eq!(allowed, Some(&["GET"][..]));
    }

    #[test]
    fn test_unknown_route_has_no_allowlist() {
        let allowed = proxy::allowed_methods_for_path("/totally-unknown");
        assert_eq!(allowed, None);
    }

    #[test]
    fn test_count_tokens_route_reports_post_allowlist() {
        let allowed = proxy::allowed_methods_for_path("/messages/count_tokens");
        assert_eq!(allowed, Some(&["POST"][..]));
    }

    #[test]
    fn test_model_ids_match_exact() {
        assert!(proxy::model_ids_match(
            "Qwen3.5-9B-MLX-4bit",
            "Qwen3.5-9B-MLX-4bit"
        ));
        assert!(proxy::model_ids_match("", ""));
    }

    #[test]
    fn test_model_ids_match_dot_underscore_equivalent() {
        // The motivating case: a client sending the underscore form must still
        // resolve to the active session whose id uses dots.
        assert!(proxy::model_ids_match(
            "Qwen3_5-9B-MLX-4bit",
            "Qwen3.5-9B-MLX-4bit",
        ));
        assert!(proxy::model_ids_match(
            "Qwen3.5-9B-MLX-4bit",
            "Qwen3_5-9B-MLX-4bit",
        ));
        assert!(proxy::model_ids_match("a.b_c", "a_b.c"));
    }

    #[test]
    fn test_model_ids_match_negatives() {
        assert!(!proxy::model_ids_match("Qwen3.5-9B", "Qwen3.5-7B"));
        assert!(!proxy::model_ids_match("Qwen3.5", "Qwen3.5-9B"));
        assert!(!proxy::model_ids_match("llama-3", "llama-4"));
        // Non-{dot,underscore} chars must still match exactly.
        assert!(!proxy::model_ids_match("a-b", "a.b"));
        assert!(!proxy::model_ids_match("a.b", "a-b"));
    }

    #[test]
    fn test_allowed_headers() {
        let allowed_headers = [
            "accept",
            "authorization",
            "content-type",
            "host",
            "origin",
            "user-agent",
            "x-api-key",
        ];
        assert!(allowed_headers.contains(&"authorization"));
        assert!(allowed_headers.contains(&"content-type"));
        assert!(allowed_headers.contains(&"x-api-key"));
    }

    // Tests for X-Api-Key header authentication support
    // The proxy now accepts either Authorization: Bearer <token> or X-Api-Key: <token>

    #[test]
    fn test_bearer_token_extraction() {
        let api_key = "test-secret-key";
        let auth_header = "Bearer test-secret-key";

        let auth_valid = auth_header
            .strip_prefix("Bearer ")
            .map(|token| token == api_key)
            .unwrap_or(false);

        assert!(auth_valid);
    }

    #[test]
    fn test_bearer_token_extraction_invalid() {
        let api_key = "test-secret-key";
        let auth_header = "Bearer wrong-key";

        let auth_valid = auth_header
            .strip_prefix("Bearer ")
            .map(|token| token == api_key)
            .unwrap_or(false);

        assert!(!auth_valid);
    }

    #[test]
    fn test_bearer_token_extraction_missing_prefix() {
        let api_key = "test-secret-key";
        let auth_header = "test-secret-key"; // Missing "Bearer " prefix

        let auth_valid = auth_header
            .strip_prefix("Bearer ")
            .map(|token| token == api_key)
            .unwrap_or(false);

        assert!(!auth_valid);
    }

    #[test]
    fn test_x_api_key_validation() {
        let api_key = "test-secret-key";
        let x_api_key_header = "test-secret-key";

        let api_key_valid = x_api_key_header == api_key;

        assert!(api_key_valid);
    }

    #[test]
    fn test_x_api_key_validation_invalid() {
        let api_key = "test-secret-key";
        let x_api_key_header = "wrong-key";

        let api_key_valid = x_api_key_header == api_key;

        assert!(!api_key_valid);
    }

    #[test]
    fn test_auth_either_header_valid_bearer() {
        let api_key = "test-secret-key";
        let auth_header = Some("Bearer test-secret-key");
        let x_api_key_header: Option<&str> = None;

        let auth_valid = auth_header
            .and_then(|auth_str| auth_str.strip_prefix("Bearer "))
            .map(|token| token == api_key)
            .unwrap_or(false);

        let api_key_valid = x_api_key_header.map(|key| key == api_key).unwrap_or(false);

        assert!(auth_valid || api_key_valid);
    }

    #[test]
    fn test_auth_either_header_valid_x_api_key() {
        let api_key = "test-secret-key";
        let auth_header: Option<&str> = None;
        let x_api_key_header = Some("test-secret-key");

        let auth_valid = auth_header
            .and_then(|auth_str| auth_str.strip_prefix("Bearer "))
            .map(|token| token == api_key)
            .unwrap_or(false);

        let api_key_valid = x_api_key_header.map(|key| key == api_key).unwrap_or(false);

        assert!(auth_valid || api_key_valid);
    }

    #[test]
    fn test_auth_both_headers_missing() {
        let api_key = "test-secret-key";
        let auth_header: Option<&str> = None;
        let x_api_key_header: Option<&str> = None;

        let auth_valid = auth_header
            .and_then(|auth_str| auth_str.strip_prefix("Bearer "))
            .map(|token| token == api_key)
            .unwrap_or(false);

        let api_key_valid = x_api_key_header.map(|key| key == api_key).unwrap_or(false);

        assert!(!auth_valid && !api_key_valid);
    }

    #[test]
    fn test_auth_both_headers_invalid() {
        let api_key = "test-secret-key";
        let auth_header = Some("Bearer wrong-key");
        let x_api_key_header = Some("also-wrong-key");

        let auth_valid = auth_header
            .and_then(|auth_str| auth_str.strip_prefix("Bearer "))
            .map(|token| token == api_key)
            .unwrap_or(false);

        let api_key_valid = x_api_key_header.map(|key| key == api_key).unwrap_or(false);

        assert!(!auth_valid && !api_key_valid);
    }

    #[test]
    fn test_auth_both_headers_one_valid() {
        let api_key = "test-secret-key";
        // Bearer is wrong but X-Api-Key is correct
        let auth_header = Some("Bearer wrong-key");
        let x_api_key_header = Some("test-secret-key");

        let auth_valid = auth_header
            .and_then(|auth_str| auth_str.strip_prefix("Bearer "))
            .map(|token| token == api_key)
            .unwrap_or(false);

        let api_key_valid = x_api_key_header.map(|key| key == api_key).unwrap_or(false);

        // Should pass if either is valid
        assert!(auth_valid || api_key_valid);
    }

    #[test]
    fn test_x_api_key_in_cors_allowed_headers() {
        // Verify x-api-key is in the CORS allowed headers list used by the proxy
        let allowed_headers = [
            "accept",
            "accept-language",
            "authorization",
            "cache-control",
            "connection",
            "content-type",
            "dnt",
            "host",
            "if-modified-since",
            "keep-alive",
            "origin",
            "user-agent",
            "x-api-key",
            "x-csrf-token",
            "x-forwarded-for",
            "x-forwarded-host",
            "x-forwarded-proto",
            "x-requested-with",
            "x-stainless-arch",
            "x-stainless-lang",
            "x-stainless-os",
            "x-stainless-package-version",
            "x-stainless-retry-count",
            "x-stainless-runtime",
            "x-stainless-runtime-version",
            "x-stainless-timeout",
        ];
        assert!(allowed_headers.contains(&"x-api-key"));
    }

    // ── /v1/responses shim (responses_shim.rs) ───────────────────────────────
    use crate::core::server::responses_shim::{
        chat_response_to_responses, responses_request_to_chat, ResponsesStreamConverter,
    };
    use serde_json::json;

    #[test]
    fn responses_request_string_input_to_chat() {
        let req = json!({
            "model": "m",
            "instructions": "you are helpful",
            "input": "hello",
            "stream": true
        });
        let chat = responses_request_to_chat(&req);
        assert_eq!(chat["model"], "m");
        assert_eq!(chat["stream"], true);
        // Streaming requests must opt into usage so we can fill response.completed.
        assert_eq!(chat["stream_options"]["include_usage"], true);
        let msgs = chat["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[0]["content"], "you are helpful");
        assert_eq!(msgs[1]["role"], "user");
        assert_eq!(msgs[1]["content"], "hello");
    }

    #[test]
    fn responses_request_merges_multiple_system_messages() {
        // `instructions` plus a developer/system input item must collapse into a
        // single leading system message so strict Qwen3 templates don't raise
        // "System message must be at the beginning".
        let req = json!({
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
        });
        let chat = responses_request_to_chat(&req);
        let msgs = chat["messages"].as_array().unwrap();
        // Exactly one system message, at index 0; all system/developer text merged.
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(
            msgs[0]["content"],
            "base policy\n\nproject rules\n\nlate system"
        );
        assert_eq!(msgs[1]["role"], "user");
        assert_eq!(msgs[1]["content"], "hi");
        let system_count = msgs.iter().filter(|m| m["role"] == "system").count();
        assert_eq!(system_count, 1);
    }

    #[test]
    fn responses_request_items_and_tools_to_chat() {
        let req = json!({
            "model": "m",
            "input": [
                {"type": "message", "role": "user",
                 "content": [{"type": "input_text", "text": "run ls"}]},
                {"type": "function_call", "name": "shell",
                 "arguments": "{\"cmd\":\"ls\"}", "call_id": "call_1"},
                {"type": "function_call_output", "call_id": "call_1", "output": "file.txt"},
                {"type": "reasoning", "summary": []}
            ],
            "tools": [{
                "type": "function", "name": "shell",
                "description": "run a shell command",
                "parameters": {"type": "object"}
            }],
            "tool_choice": "auto",
            "max_output_tokens": 256
        });
        let chat = responses_request_to_chat(&req);
        let msgs = chat["messages"].as_array().unwrap();
        // reasoning item dropped -> user + assistant(tool_call) + tool
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0]["content"], "run ls");
        assert_eq!(msgs[1]["tool_calls"][0]["id"], "call_1");
        assert_eq!(msgs[1]["tool_calls"][0]["function"]["name"], "shell");
        assert_eq!(msgs[2]["role"], "tool");
        assert_eq!(msgs[2]["tool_call_id"], "call_1");
        assert_eq!(msgs[2]["content"], "file.txt");
        // tool flattened into chat schema
        assert_eq!(chat["tools"][0]["type"], "function");
        assert_eq!(chat["tools"][0]["function"]["name"], "shell");
        assert_eq!(chat["tool_choice"], "auto");
        assert_eq!(chat["max_tokens"], 256);
    }

    #[test]
    fn chat_response_nonstream_to_responses_text() {
        let chat = json!({
            "model": "m",
            "choices": [{"message": {"role": "assistant", "content": "hi there"},
                         "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7}
        });
        let resp = chat_response_to_responses(&chat, "resp_x", "fallback");
        assert_eq!(resp["object"], "response");
        assert_eq!(resp["status"], "completed");
        assert_eq!(resp["id"], "resp_x");
        assert_eq!(resp["output"][0]["type"], "message");
        assert_eq!(resp["output"][0]["content"][0]["text"], "hi there");
        assert_eq!(resp["usage"]["input_tokens"], 5);
        assert_eq!(resp["usage"]["output_tokens"], 2);
        assert_eq!(resp["usage"]["total_tokens"], 7);
    }

    #[test]
    fn chat_response_nonstream_to_responses_tool_call() {
        let chat = json!({
            "model": "m",
            "choices": [{"message": {
                "role": "assistant",
                "content": serde_json::Value::Null,
                "tool_calls": [{
                    "id": "call_9", "type": "function",
                    "function": {"name": "shell", "arguments": "{\"cmd\":\"ls\"}"}
                }]
            }, "finish_reason": "tool_calls"}]
        });
        let resp = chat_response_to_responses(&chat, "resp_y", "m");
        let out = resp["output"].as_array().unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["type"], "function_call");
        assert_eq!(out[0]["call_id"], "call_9");
        assert_eq!(out[0]["name"], "shell");
        assert_eq!(out[0]["arguments"], "{\"cmd\":\"ls\"}");
    }

    #[test]
    fn stream_converter_text_sequence() {
        let mut conv = ResponsesStreamConverter::new("resp_s".into(), "m".into());
        let created = conv.created_event();
        assert_eq!(created["type"], "response.created");
        assert_eq!(created["response"]["status"], "in_progress");

        let mut types: Vec<String> = Vec::new();
        for delta in [
            json!({"choices":[{"delta":{"role":"assistant"}}]}),
            json!({"choices":[{"delta":{"content":"He"}}]}),
            json!({"choices":[{"delta":{"content":"llo"}}]}),
            json!({"choices":[{"delta":{},"finish_reason":"stop"}]}),
        ] {
            for ev in conv.on_chunk(&delta) {
                types.push(ev["type"].as_str().unwrap().to_string());
            }
        }
        // First text delta opens the message item + content part.
        assert!(types.contains(&"response.output_item.added".to_string()));
        assert!(types.contains(&"response.content_part.added".to_string()));
        assert_eq!(
            types
                .iter()
                .filter(|t| *t == "response.output_text.delta")
                .count(),
            2
        );

        let closers = conv.finish(Some(&json!({
            "prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4
        })));
        let closer_types: Vec<&str> = closers
            .iter()
            .map(|e| e["type"].as_str().unwrap())
            .collect();
        assert!(closer_types.contains(&"response.output_text.done"));
        assert!(closer_types.contains(&"response.output_item.done"));
        let completed = closers.last().unwrap();
        assert_eq!(completed["type"], "response.completed");
        assert_eq!(completed["response"]["status"], "completed");
        assert_eq!(
            completed["response"]["output"][0]["content"][0]["text"],
            "Hello"
        );
        assert_eq!(completed["response"]["usage"]["output_tokens"], 1);
    }

    #[test]
    fn stream_converter_tool_call_sequence() {
        let mut conv = ResponsesStreamConverter::new("resp_t".into(), "m".into());
        let _ = conv.created_event();

        let chunks = [
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1",
                "type":"function","function":{"name":"shell","arguments":"{\"cmd"}}]}}]}),
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,
                "function":{"arguments":"\":\"ls\"}"}}]}}]}),
            json!({"choices":[{"delta":{},"finish_reason":"tool_calls"}]}),
        ];
        let mut types: Vec<String> = Vec::new();
        for c in chunks {
            for ev in conv.on_chunk(&c) {
                types.push(ev["type"].as_str().unwrap().to_string());
            }
        }
        assert!(types.contains(&"response.output_item.added".to_string()));
        assert!(types.contains(&"response.function_call_arguments.delta".to_string()));

        let closers = conv.finish(None);
        let completed = closers.last().unwrap();
        assert_eq!(completed["type"], "response.completed");
        let item = &completed["response"]["output"][0];
        assert_eq!(item["type"], "function_call");
        assert_eq!(item["call_id"], "call_1");
        assert_eq!(item["name"], "shell");
        assert_eq!(item["arguments"], "{\"cmd\":\"ls\"}");
    }

    fn fixture(name: &str) -> serde_json::Value {
        let raw = match name {
            "chat" => include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../tests/fixtures/proxy/openai-chat-completion.json"
            )),
            "tool" => include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../tests/fixtures/proxy/openai-tool-completion.json"
            )),
            "stream" => include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../tests/fixtures/proxy/openai-chat-stream.json"
            )),
            _ => panic!("unknown fixture"),
        };
        serde_json::from_str(raw).unwrap()
    }

    #[test]
    fn sanitized_chat_fixture_replays_through_response_transforms() {
        let chat = fixture("chat");

        let responses = chat_response_to_responses(&chat, "resp_fixture", "fallback");
        assert_eq!(responses["status"], "completed");
        assert_eq!(responses["model"], "<model>");
        assert_eq!(responses["output"][0]["content"][0]["text"], "<content>");
        assert_eq!(responses["usage"]["total_tokens"], 2);

        let anthropic = proxy::transform_openai_response_to_anthropic(&chat);
        assert_eq!(anthropic["type"], "message");
        assert_eq!(anthropic["content"][0]["type"], "text");
        assert_eq!(anthropic["content"][0]["text"], "<content>");
        assert_eq!(anthropic["stop_reason"], "end_turn");
    }

    #[test]
    fn sanitized_tool_fixture_replays_through_response_transforms() {
        let chat = fixture("tool");

        let responses = chat_response_to_responses(&chat, "resp_fixture", "fallback");
        let function_call = &responses["output"][0];
        assert_eq!(function_call["type"], "function_call");
        assert_eq!(function_call["name"], "get_temperature");
        assert_eq!(function_call["arguments"], "{\"location\":\"Paris\"}");

        let anthropic = proxy::transform_openai_response_to_anthropic(&chat);
        assert_eq!(anthropic["content"][0]["type"], "tool_use");
        assert_eq!(anthropic["content"][0]["name"], "get_temperature");
        assert_eq!(anthropic["content"][0]["input"]["location"], "Paris");
        assert_eq!(anthropic["stop_reason"], "tool_use");
    }

    #[test]
    fn sanitized_stream_fixture_replays_in_deterministic_order() {
        let chunks = fixture("stream").as_array().unwrap().clone();
        let mut conv = ResponsesStreamConverter::new("resp_fixture".into(), "<model>".into());
        let mut events = vec![conv.created_event()];
        let mut usage = None;

        for chunk in &chunks {
            if let Some(value) = chunk.get("usage") {
                usage = Some(value.clone());
            }
            events.extend(conv.on_chunk(chunk));
        }
        events.extend(conv.finish(usage.as_ref()));

        let sequence_numbers: Vec<u64> = events
            .iter()
            .map(|event| event["sequence_number"].as_u64().unwrap())
            .collect();
        assert_eq!(
            sequence_numbers,
            (0..sequence_numbers.len() as u64).collect::<Vec<_>>()
        );
        assert_eq!(events.first().unwrap()["type"], "response.created");
        assert_eq!(events.last().unwrap()["type"], "response.completed");
        assert_eq!(
            events.last().unwrap()["response"]["output"][0]["content"][0]["text"],
            "fixture"
        );
        assert_eq!(
            events.last().unwrap()["response"]["usage"]["total_tokens"],
            2
        );
    }

    // ── ChatGPT subscription shim (chat_to_responses_shim.rs) ────────────────
    //
    // The mirror of the section above. These pin the wire shape we send to
    // `chatgpt.com/backend-api/codex/responses` and the chunks we hand back.
    use crate::core::server::chat_to_responses_shim::{
        chat_request_to_responses, chat_response_format_to_text, chat_tool_choice_to_responses,
        chat_tool_to_responses, map_usage_reverse, normalize_function_schema, responses_call_id,
        ChatChunkStreamConverter, COMPATIBILITY_INSTRUCTIONS,
    };

    fn to_responses(body: &serde_json::Value) -> serde_json::Value {
        chat_request_to_responses(body, "cache-key")
    }

    fn converter() -> ChatChunkStreamConverter {
        ChatChunkStreamConverter::new("gpt-5.4", 1_700_000_000)
    }

    #[test]
    fn chat_request_hoists_system_turns_into_instructions() {
        let req = json!({
            "model": "gpt-5.4",
            "messages": [
                {"role": "system", "content": "be terse"},
                {"role": "user", "content": "hello"},
                {"role": "developer", "content": "and precise"}
            ]
        });
        let out = to_responses(&req);

        assert_eq!(out["model"], "gpt-5.4");
        // Both system-ish turns are joined, in order, out of the input array,
        // behind the compatibility preamble the endpoint's models expect.
        assert_eq!(
            out["instructions"],
            format!("{COMPATIBILITY_INSTRUCTIONS}\n\nbe terse\n\nand precise")
        );
        let input = out["input"].as_array().unwrap();
        assert_eq!(input.len(), 1);
        // A user turn is a bare {role, content} — no `type: "message"`.
        assert!(input[0].get("type").is_none());
        assert_eq!(input[0]["role"], "user");
        assert_eq!(input[0]["content"][0]["type"], "input_text");
        assert_eq!(input[0]["content"][0]["text"], "hello");
    }

    #[test]
    fn chat_request_always_streams_and_never_stores() {
        // The endpoint only streams, and we never want the conversation kept.
        // The client's own `stream` preference is honoured by aggregating on
        // the way back, not by asking upstream for a non-streamed reply.
        let req = json!({"model": "m", "messages": [], "stream": false});
        let out = to_responses(&req);
        assert_eq!(out["stream"], true);
        assert_eq!(out["store"], false);
    }

    #[test]
    fn the_output_cap_and_sampling_knobs_are_dropped() {
        // The Codex Responses endpoint rejects `max_output_tokens` even though
        // the public Responses API accepts it — the subscription applies its
        // own cap — and sampling is not part of this contract. Forwarding any
        // of them fails the whole request, so they are dropped rather than
        // translated.
        let out = to_responses(&json!({
            "messages": [],
            "max_tokens": 256,
            "max_completion_tokens": 512,
            "temperature": 0.7,
            "top_p": 0.9
        }));
        assert!(out.get("max_output_tokens").is_none());
        assert!(out.get("max_tokens").is_none());
        assert!(out.get("temperature").is_none());
        assert!(out.get("top_p").is_none());
    }

    #[test]
    fn the_request_carries_the_subscription_specific_fields() {
        let out = to_responses(&json!({"messages": []}));
        assert_eq!(out["include"], json!(["reasoning.encrypted_content"]));
        assert_eq!(out["prompt_cache_key"], "cache-key");
        assert_eq!(out["parallel_tool_calls"], true);
        assert_eq!(out["text"]["verbosity"], "low");
        // Absent from the client request, `tool_choice` still has to be there.
        assert_eq!(out["tool_choice"], "auto");
    }

    #[test]
    fn reasoning_effort_is_forwarded_with_a_summary() {
        let out = to_responses(&json!({"messages": [], "reasoning_effort": "high"}));
        assert_eq!(
            out["reasoning"],
            json!({"effort": "high", "summary": "auto"})
        );
        assert!(to_responses(&json!({"messages": []}))
            .get("reasoning")
            .is_none());
    }

    #[test]
    fn assistant_text_and_tool_calls_become_separate_items() {
        let req = json!({"messages": [{
            "role": "assistant",
            "content": "calling a tool",
            "tool_calls": [{
                "id": "call_1",
                "type": "function",
                "function": {"name": "search", "arguments": "{\"q\":\"rust\"}"}
            }]
        }]});
        let input = to_responses(&req)["input"].clone();
        let input = input.as_array().unwrap();

        assert_eq!(input.len(), 2);
        // An assistant turn is replayed as a completed output item.
        assert_eq!(input[0]["type"], "message");
        assert_eq!(input[0]["status"], "completed");
        // What the assistant produced is `output_text`, with annotations.
        assert_eq!(input[0]["content"][0]["type"], "output_text");
        assert_eq!(input[0]["content"][0]["annotations"], json!([]));
        assert_eq!(input[1]["type"], "function_call");
        assert_eq!(input[1]["call_id"], "call_1");
        assert_eq!(input[1]["name"], "search");
        assert_eq!(input[1]["arguments"], "{\"q\":\"rust\"}");
    }

    #[test]
    fn tool_results_become_function_call_output() {
        let req = json!({"messages": [
            {"role": "tool", "tool_call_id": "call_1", "content": "42"}
        ]});
        let input = to_responses(&req)["input"].clone();
        let input = input.as_array().unwrap();

        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["type"], "function_call_output");
        assert_eq!(input[0]["call_id"], "call_1");
        assert_eq!(input[0]["output"], "42");
    }

    #[test]
    fn image_parts_survive_as_input_image() {
        let req = json!({"messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": "what is this"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAA"}}
            ]
        }]});
        let input = to_responses(&req)["input"].clone();
        let parts = input[0]["content"].as_array().unwrap().clone();

        assert_eq!(parts[0]["type"], "input_text");
        assert_eq!(parts[1]["type"], "input_image");
        assert_eq!(parts[1]["detail"], "auto");
        assert_eq!(parts[1]["image_url"], "data:image/png;base64,AAA");
    }

    #[test]
    fn tools_are_flattened_out_of_the_function_wrapper() {
        let tool = json!({
            "type": "function",
            "function": {
                "name": "search",
                "description": "look things up",
                "parameters": {"type": "object"}
            }
        });
        let out = chat_tool_to_responses(&tool).unwrap();
        assert_eq!(out["type"], "function");
        assert_eq!(out["name"], "search");
        assert_eq!(out["description"], "look things up");
        assert_eq!(out["parameters"]["type"], "object");
        assert!(out.get("function").is_none());

        // Non-function tools have no Responses equivalent here.
        assert!(chat_tool_to_responses(&json!({"type": "web_search"})).is_none());
    }

    #[test]
    fn object_schemas_always_get_properties() {
        // The endpoint rejects an object schema without `properties`, and a
        // tool it rejects is indistinguishable from a broken request.
        let normalized = normalize_function_schema(Some(&json!({"type": "object"})));
        assert_eq!(normalized["properties"], json!({}));

        // Including the ones nested inside combinators.
        let nested = normalize_function_schema(Some(&json!({
            "type": "object",
            "properties": {"inner": {"type": "object"}},
            "anyOf": [{"type": "object"}]
        })));
        assert_eq!(nested["properties"]["inner"]["properties"], json!({}));
        assert_eq!(nested["anyOf"][0]["properties"], json!({}));

        // A non-object schema is left exactly as it was.
        let scalar = normalize_function_schema(Some(&json!({"type": "string"})));
        assert!(scalar.get("properties").is_none());
        // And a missing schema still describes something callable.
        assert_eq!(
            normalize_function_schema(None),
            json!({"type": "object", "properties": {}})
        );
    }

    #[test]
    fn over_long_call_ids_are_shortened_without_colliding() {
        let short = "call_abc";
        assert_eq!(responses_call_id(short), short);

        let long_a = format!("call_{}", "a".repeat(80));
        let long_b = format!("call_{}", "a".repeat(79) + "b");
        let a = responses_call_id(&long_a);
        let b = responses_call_id(&long_b);
        assert!(a.len() <= 64, "{a}");
        // The shared 31-char prefix must not be enough to merge them.
        assert_ne!(a, b);
    }

    #[test]
    fn tool_choice_loses_the_function_wrapper_too() {
        assert_eq!(chat_tool_choice_to_responses(&json!("auto")), json!("auto"));
        assert_eq!(
            chat_tool_choice_to_responses(&json!({"type": "function", "function": {"name": "s"}})),
            json!({"type": "function", "name": "s"})
        );
    }

    #[test]
    fn response_format_becomes_text_format() {
        let rf = json!({
            "type": "json_schema",
            "json_schema": {"name": "answer", "schema": {"type": "object"}, "strict": true}
        });
        let out = chat_response_format_to_text(&rf).unwrap();
        assert_eq!(out["type"], "json_schema");
        assert_eq!(out["name"], "answer");
        assert_eq!(out["strict"], true);

        assert_eq!(
            chat_response_format_to_text(&json!({"type": "json_object"})).unwrap(),
            json!({"type": "json_object"})
        );
        assert!(chat_response_format_to_text(&json!({"type": "text"})).is_none());
    }

    #[test]
    fn usage_maps_back_to_the_chat_names() {
        let usage = json!({"input_tokens": 10, "output_tokens": 4, "total_tokens": 14});
        assert_eq!(
            map_usage_reverse(&usage),
            json!({"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14})
        );
        // Total is derived when the upstream omits it.
        assert_eq!(
            map_usage_reverse(&json!({"input_tokens": 3, "output_tokens": 2}))["total_tokens"],
            5
        );
    }

    #[test]
    fn text_deltas_become_chunks_with_the_role_sent_once() {
        let mut conv = converter();
        let first = conv.on_event(&json!({
            "type": "response.output_text.delta", "delta": "Hel"
        }));
        let second = conv.on_event(&json!({
            "type": "response.output_text.delta", "delta": "lo"
        }));

        assert_eq!(first.len(), 1);
        assert_eq!(first[0]["object"], "chat.completion.chunk");
        assert_eq!(first[0]["choices"][0]["delta"]["role"], "assistant");
        assert_eq!(first[0]["choices"][0]["delta"]["content"], "Hel");
        // The role belongs on the first chunk only.
        assert!(second[0]["choices"][0]["delta"].get("role").is_none());
        assert_eq!(second[0]["choices"][0]["delta"]["content"], "lo");
    }

    #[test]
    fn the_served_model_overrides_the_requested_one() {
        let mut conv = converter();
        conv.on_event(&json!({
            "type": "response.created", "response": {"model": "gpt-5.4-2026-01-01"}
        }));
        let chunks = conv.on_event(&json!({
            "type": "response.output_text.delta", "delta": "x"
        }));
        assert_eq!(chunks[0]["model"], "gpt-5.4-2026-01-01");
    }

    #[test]
    fn reasoning_deltas_use_the_de_facto_field() {
        let mut conv = converter();
        let chunks = conv.on_event(&json!({
            "type": "response.reasoning_summary_text.delta", "delta": "thinking"
        }));
        assert_eq!(
            chunks[0]["choices"][0]["delta"]["reasoning_content"],
            "thinking"
        );
    }

    #[test]
    fn function_calls_get_a_chat_style_index() {
        let mut conv = converter();
        let opened = conv.on_event(&json!({
            "type": "response.output_item.added",
            "item": {"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "search"}
        }));
        assert_eq!(
            opened[0]["choices"][0]["delta"]["tool_calls"][0]["index"],
            0
        );
        assert_eq!(
            opened[0]["choices"][0]["delta"]["tool_calls"][0]["id"],
            "call_1"
        );
        assert_eq!(
            opened[0]["choices"][0]["delta"]["tool_calls"][0]["function"]["name"],
            "search"
        );

        let args = conv.on_event(&json!({
            "type": "response.function_call_arguments.delta",
            "item_id": "fc_1",
            "delta": "{\"q\":"
        }));
        assert_eq!(args[0]["choices"][0]["delta"]["tool_calls"][0]["index"], 0);
        assert_eq!(
            args[0]["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"],
            "{\"q\":"
        );

        // A second call takes the next index, which is the only thing chat
        // chunks have to tell them apart.
        let second = conv.on_event(&json!({
            "type": "response.output_item.added",
            "item": {"type": "function_call", "id": "fc_2", "call_id": "call_2", "name": "fetch"}
        }));
        assert_eq!(
            second[0]["choices"][0]["delta"]["tool_calls"][0]["index"],
            1
        );
    }

    #[test]
    fn completion_finishes_with_tool_calls_when_a_tool_was_opened() {
        let mut conv = converter();
        conv.on_event(&json!({
            "type": "response.output_item.added",
            "item": {"type": "function_call", "id": "fc_1", "call_id": "c", "name": "n"}
        }));
        let done = conv.on_event(&json!({
            "type": "response.completed",
            "response": {"usage": {"input_tokens": 7, "output_tokens": 3}}
        }));

        assert_eq!(done.len(), 1);
        assert_eq!(done[0]["choices"][0]["finish_reason"], "tool_calls");
        // Usage rides the terminal chunk itself.
        assert_eq!(done[0]["usage"]["prompt_tokens"], 7);
    }

    #[test]
    fn an_incomplete_response_finishes_as_length_not_stop() {
        // The upstream stopped at a cap. Reporting `stop` would tell the
        // client a truncated answer was a finished one.
        let mut conv = converter();
        conv.on_event(&json!({"type": "response.output_text.delta", "delta": "half a "}));
        let done = conv.on_event(&json!({"type": "response.incomplete", "response": {}}));
        assert_eq!(done[0]["choices"][0]["finish_reason"], "length");
    }

    #[test]
    fn a_whole_function_call_arriving_at_once_is_still_announced() {
        // Some streams skip `output_item.added` and the argument deltas.
        let mut conv = converter();
        let chunks = conv.on_event(&json!({
            "type": "response.output_item.done",
            "item": {
                "type": "function_call", "id": "fc_1", "call_id": "call_1",
                "name": "search", "arguments": "{\"q\":\"rust\"}"
            }
        }));
        assert_eq!(
            chunks[0]["choices"][0]["delta"]["tool_calls"][0]["id"],
            "call_1"
        );
        assert_eq!(
            chunks[0]["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"],
            "{\"q\":\"rust\"}"
        );

        // A call that already streamed normally is not announced twice.
        let mut conv = converter();
        conv.on_event(&json!({
            "type": "response.output_item.added",
            "item": {"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "search"}
        }));
        assert!(conv
            .on_event(&json!({
                "type": "response.output_item.done",
                "item": {
                    "type": "function_call", "id": "fc_1", "call_id": "call_1",
                    "name": "search", "arguments": "{}"
                }
            }))
            .is_empty());
    }

    #[test]
    fn a_refusal_reaches_the_client_as_content() {
        // Dropping it would end the turn with an empty message and no reason.
        let mut conv = converter();
        let chunks = conv.on_event(&json!({
            "type": "response.refusal.delta", "delta": "I can't help with that."
        }));
        assert_eq!(
            chunks[0]["choices"][0]["delta"]["content"],
            "I can't help with that."
        );
    }

    #[test]
    fn plain_text_completions_finish_with_stop() {
        let mut conv = converter();
        conv.on_event(&json!({"type": "response.output_text.delta", "delta": "hi"}));
        let done = conv.on_event(&json!({"type": "response.completed", "response": {}}));
        assert_eq!(done[0]["choices"][0]["finish_reason"], "stop");
        // No usage block upstream means no trailing usage chunk.
        assert_eq!(done.len(), 1);
    }

    #[test]
    fn events_after_the_terminal_one_are_ignored() {
        let mut conv = converter();
        conv.on_event(&json!({"type": "response.completed", "response": {}}));
        assert!(conv
            .on_event(&json!({"type": "response.output_text.delta", "delta": "late"}))
            .is_empty());
        assert!(conv.finish().is_empty());
    }

    #[test]
    fn a_dropped_stream_still_gets_its_finish_chunk() {
        let mut conv = converter();
        conv.on_event(&json!({"type": "response.output_text.delta", "delta": "partial"}));
        let tail = conv.finish();
        assert_eq!(tail.len(), 1);
        assert_eq!(tail[0]["choices"][0]["finish_reason"], "stop");
    }

    #[test]
    fn an_upstream_failure_is_reported_rather_than_swallowed() {
        let mut conv = converter();
        let chunks = conv.on_event(&json!({
            "type": "response.failed",
            "response": {"error": {"message": "usage limit reached"}}
        }));
        assert_eq!(chunks[0]["choices"][0]["finish_reason"], "stop");
        assert_eq!(conv.error(), Some("usage limit reached"));
    }

    #[test]
    fn unknown_events_are_dropped_without_disturbing_the_stream() {
        let mut conv = converter();
        assert!(conv
            .on_event(&json!({"type": "response.content_part.added"}))
            .is_empty());
        assert!(conv.on_event(&json!({"no": "type"})).is_empty());
        let chunks = conv.on_event(&json!({
            "type": "response.output_text.delta", "delta": "still here"
        }));
        // The role has not been spent by the ignored events.
        assert_eq!(chunks[0]["choices"][0]["delta"]["role"], "assistant");
    }

    #[test]
    fn the_same_converter_aggregates_a_non_streamed_reply() {
        let mut conv = converter();
        conv.on_event(&json!({"type": "response.output_text.delta", "delta": "the "}));
        conv.on_event(&json!({"type": "response.output_text.delta", "delta": "answer"}));
        conv.on_event(&json!({
            "type": "response.output_item.added",
            "item": {"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "search"}
        }));
        conv.on_event(&json!({
            "type": "response.function_call_arguments.delta",
            "item_id": "fc_1",
            "delta": "{}"
        }));
        conv.on_event(&json!({
            "type": "response.completed",
            "response": {"usage": {"input_tokens": 1, "output_tokens": 2, "total_tokens": 3}}
        }));

        let completion = conv.into_chat_completion();
        assert_eq!(completion["object"], "chat.completion");
        assert_eq!(completion["choices"][0]["message"]["content"], "the answer");
        assert_eq!(
            completion["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"],
            "{}"
        );
        assert_eq!(completion["choices"][0]["finish_reason"], "tool_calls");
        assert_eq!(completion["usage"]["total_tokens"], 3);
    }

    #[test]
    fn an_empty_reply_aggregates_to_null_content_not_an_empty_string() {
        // `content: ""` reads as "the model said nothing"; `null` is what the
        // Chat API uses for a turn that produced only tool calls.
        let conv = converter();
        let completion = conv.into_chat_completion();
        assert!(completion["choices"][0]["message"]["content"].is_null());
    }
}
