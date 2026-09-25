//! Golden fixtures for the ChatGPT subscription sign-in, captured from the real
//! functions (PLAN.md §4 stage 4c).
//!
//! Everything here is deterministic: PKCE derivation from a given verifier, the
//! authorize URL for a given challenge and state, callback query parsing, the
//! `state` comparison, JWT claim decoding, turning a token-endpoint response into
//! the stored session, the token file's bytes and how it reads back, and expiry.
//! The two network calls (`exchange_code`, `refresh_tokens`) are not captured:
//! they talk to a pinned `https://auth.openai.com` and cannot be pointed at a
//! stub without changing the code under test.
//!
//! A child module of `chatgpt.rs` so the private `to_stored` and
//! `TokenResponse` can be driven without widening their visibility.
//!
//! Run: `cargo test --lib -- --ignored auth::chatgpt::fixture_dump --test-threads=1`.

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use serde_json::{json, Value};

use super::*;
use crate::core::auth::store::{self, StoredTokens, TOKEN_FILE_VERSION};

fn jwt(payload: Value) -> String {
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"none","typ":"JWT"}"#);
    let body = URL_SAFE_NO_PAD.encode(payload.to_string());
    format!("{header}.{body}.sig")
}

fn stored_json(tokens: &StoredTokens) -> Value {
    serde_json::to_value(tokens).unwrap()
}

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

struct Case {
    name: String,
    source: &'static str,
    input: Value,
    expected: Value,
}

fn case(name: &str, source: &'static str, input: Value, expected: Value) -> Case {
    Case {
        name: name.to_string(),
        source,
        input,
        expected,
    }
}

const CHATGPT_RS: &str = "src-tauri/src/core/auth/chatgpt.rs";
const STORE_RS: &str = "src-tauri/src/core/auth/store.rs";

fn pkce_cases() -> Vec<Case> {
    let mut out = Vec::new();
    for (name, verifier) in [
        ("pkce_rfc7636_vector", "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
        ("pkce_short_verifier", "abc"),
        ("pkce_unicode_verifier", "vérifier-ключ"),
    ] {
        out.push(case(
            name,
            CHATGPT_RS,
            json!({"kind": "derive_challenge", "verifier": verifier}),
            json!({"challenge": derive_challenge(verifier)}),
        ));
    }
    let pkce = Pkce {
        verifier: "verifier-not-in-url".into(),
        challenge: derive_challenge("verifier-not-in-url"),
    };
    for (name, state) in [
        ("authorize_url_plain_state", "state-123"),
        ("authorize_url_state_needing_escapes", "a b/c+d=e&f"),
    ] {
        out.push(case(
            name,
            CHATGPT_RS,
            json!({"kind": "authorize_url", "challenge": pkce.challenge, "state": state}),
            json!({"url": authorize_url(&pkce, state)}),
        ));
    }
    out.push(case(
        "redirect_uri_fixed_loopback",
        CHATGPT_RS,
        json!({"kind": "redirect_uri"}),
        json!({"redirect_uri": redirect_uri()}),
    ));
    out
}

fn callback_cases() -> Vec<Case> {
    let queries = [
        ("callback_code_and_state", "code=abc&state=xyz"),
        ("callback_extra_params_ignored", "scope=openid&code=abc&state=xyz&foo=bar"),
        ("callback_percent_and_plus_decoded", "code=a%2Fb+c&state=s%3D1"),
        ("callback_error_with_description", "error=access_denied&error_description=User+declined&code=abc&state=xyz"),
        ("callback_error_without_description", "error=invalid_request"),
        ("callback_missing_code", "state=xyz"),
        ("callback_empty_code", "code=&state=xyz"),
        ("callback_missing_state", "code=abc"),
        ("callback_empty_state", "code=abc&state="),
        ("callback_empty_query", ""),
        ("callback_repeated_code_last_wins", "code=first&code=second&state=xyz"),
    ];
    queries
        .into_iter()
        .map(|(name, query)| {
            let expected = match parse_callback_query(query) {
                Ok(CallbackParams::Code { code, state }) => {
                    json!({"ok": {"kind": "code", "code": code, "state": state}})
                }
                Ok(CallbackParams::Error { error, description }) => {
                    json!({"ok": {"kind": "error", "error": error, "description": description}})
                }
                Err(err) => json!({"err": err}),
            };
            case(name, CHATGPT_RS, json!({"kind": "parse_callback_query", "query": query}), expected)
        })
        .chain(
            [
                ("state_matches_equal", "abc", "abc"),
                ("state_matches_different_length", "abc", "abcd"),
                ("state_matches_same_length_different", "abc", "abd"),
                ("state_matches_empty", "", ""),
            ]
            .into_iter()
            .map(|(name, expected, received)| {
                case(
                    name,
                    CHATGPT_RS,
                    json!({"kind": "state_matches", "expected": expected, "received": received}),
                    json!({"matches": state_matches(expected, received)}),
                )
            }),
        )
        .collect()
}

fn claims_json(claims: &IdClaims) -> Value {
    json!({"account_id": claims.account_id, "plan_type": claims.plan_type, "email": claims.email})
}

fn jwt_cases() -> Vec<Case> {
    let full = jwt(json!({
        "email": "user@example.test",
        "https://api.openai.com/auth": {"chatgpt_account_id": "acct_1", "chatgpt_plan_type": "plus"}
    }));
    // Standard alphabet with padding stripped: `+` and `/` instead of `-` and `_`.
    let standard_payload = STANDARD
        .encode(json!({"email": "~~~>>>???", "https://api.openai.com/auth": {"chatgpt_account_id": "acct_std"}}).to_string())
        .trim_end_matches('=')
        .to_string();
    let tokens = [
        ("jwt_full_claims", full),
        ("jwt_email_only", jwt(json!({"email": "only@example.test"}))),
        ("jwt_namespace_only", jwt(json!({"https://api.openai.com/auth": {"chatgpt_plan_type": "pro"}}))),
        ("jwt_non_string_claims_ignored", jwt(json!({"email": 7, "https://api.openai.com/auth": {"chatgpt_account_id": true}}))),
        ("jwt_standard_alphabet_accepted", format!("h.{standard_payload}.s")),
        ("jwt_padded_payload", format!("h.{}.s", STANDARD.encode(br#"{"email":"pad@example.test"}"#))),
        ("jwt_single_segment", "onlyonepart".to_string()),
        ("jwt_payload_not_base64", "h.!!!.s".to_string()),
        ("jwt_payload_not_json", format!("h.{}.s", URL_SAFE_NO_PAD.encode("not json"))),
        ("jwt_payload_json_array", format!("h.{}.s", URL_SAFE_NO_PAD.encode("[1,2]"))),
        ("jwt_empty", String::new()),
    ];
    tokens
        .into_iter()
        .map(|(name, token)| {
            let claims = decode_jwt_claims(&token);
            case(name, CHATGPT_RS, json!({"kind": "decode_jwt_claims", "token": token}), json!({"claims": claims_json(&claims)}))
        })
        .collect()
}

fn to_stored_cases() -> Vec<Case> {
    let access = jwt(json!({
        "email": "access@example.test",
        "https://api.openai.com/auth": {"chatgpt_account_id": "acct_access", "chatgpt_plan_type": "plus"}
    }));
    let id = jwt(json!({
        "email": "id@example.test",
        "https://api.openai.com/auth": {"chatgpt_account_id": "acct_id", "chatgpt_plan_type": "team"}
    }));
    let id_only_account = jwt(json!({"https://api.openai.com/auth": {"chatgpt_account_id": "acct_from_id"}}));
    let responses: Vec<(&str, Value, Option<&str>)> = vec![
        ("to_stored_full_response", json!({"access_token": access, "refresh_token": "r1", "id_token": id, "expires_in": 7200}), None),
        ("to_stored_refresh_keeps_previous_refresh_token", json!({"access_token": access, "expires_in": 3600}), Some("r-old")),
        ("to_stored_rotated_refresh_token_wins", json!({"access_token": access, "refresh_token": "r-new"}), Some("r-old")),
        ("to_stored_missing_refresh_token_is_an_error", json!({"access_token": access}), None),
        ("to_stored_default_lifetime_one_hour", json!({"access_token": "opaque", "refresh_token": "r"}), None),
        ("to_stored_lifetime_clamped_up", json!({"access_token": "opaque", "refresh_token": "r", "expires_in": 5}), None),
        ("to_stored_lifetime_clamped_down", json!({"access_token": "opaque", "refresh_token": "r", "expires_in": 999_999_999}), None),
        ("to_stored_negative_lifetime_clamped", json!({"access_token": "opaque", "refresh_token": "r", "expires_in": -30}), None),
        ("to_stored_account_falls_back_to_id_token", json!({"access_token": "opaque", "refresh_token": "r", "id_token": id_only_account}), None),
        ("to_stored_email_falls_back_to_access_token", json!({"access_token": access, "refresh_token": "r"}), None),
        ("to_stored_unknown_fields_ignored", json!({"access_token": "opaque", "refresh_token": "r", "token_type": "Bearer", "scope": "openid"}), None),
        ("to_stored_null_optionals", json!({"access_token": "opaque", "refresh_token": null, "id_token": null, "expires_in": null}), Some("r-prev")),
    ];
    let now = 1_750_000_000_i64;
    let mut out: Vec<Case> = responses
        .into_iter()
        .map(|(name, body, previous)| {
            let parsed: TokenResponse = serde_json::from_value(body.clone()).expect("token response");
            let expected = match to_stored(parsed, now, previous) {
                Ok(tokens) => json!({"ok": stored_json(&tokens)}),
                Err(err) => json!({"err": err}),
            };
            case(
                name,
                CHATGPT_RS,
                json!({"kind": "to_stored", "response": body, "now_unix": now, "previous_refresh": previous}),
                expected,
            )
        })
        .collect();
    // A body the endpoint could send that serde refuses outright.
    for (name, body) in [
        ("token_response_missing_access_token_rejected", json!({"refresh_token": "r"})),
        ("token_response_non_integer_lifetime_rejected", json!({"access_token": "a", "refresh_token": "r", "expires_in": 1.5})),
    ] {
        let expected = match serde_json::from_value::<TokenResponse>(body.clone()) {
            Ok(_) => json!({"parses": true}),
            Err(_) => json!({"parses": false}),
        };
        out.push(case(name, CHATGPT_RS, json!({"kind": "parse_token_response", "response": body}), expected));
    }
    out
}

fn store_cases() -> Vec<Case> {
    let dir = std::env::temp_dir().join("atomic-chatgpt-auth-fixture-dump");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let mut out = Vec::new();
    let full = StoredTokens {
        version: TOKEN_FILE_VERSION,
        access_token: "access-abc".into(),
        refresh_token: "refresh-xyz".into(),
        id_token: Some("id.token.value".into()),
        account_id: Some("acct_1".into()),
        plan_type: Some("plus".into()),
        email: Some("user@example.test".into()),
        expires_at: 1_750_003_600,
    };
    let minimal = StoredTokens {
        id_token: None,
        account_id: None,
        plan_type: None,
        email: None,
        ..full.clone()
    };
    for (name, tokens) in [("store_save_full_session", &full), ("store_save_minimal_session", &minimal)] {
        store::save(&dir, tokens).unwrap();
        let text = std::fs::read_to_string(store::token_file_path(&dir)).unwrap();
        #[cfg(unix)]
        let mode = {
            use std::os::unix::fs::PermissionsExt;
            json!(std::fs::metadata(store::token_file_path(&dir)).unwrap().permissions().mode() & 0o777)
        };
        #[cfg(not(unix))]
        let mode = Value::Null;
        out.push(case(
            name,
            STORE_RS,
            json!({"kind": "save", "tokens": stored_json(tokens)}),
            json!({"text": text, "mode": mode}),
        ));
    }

    let files: Vec<(&str, Option<String>)> = vec![
        ("store_load_absent_file", None),
        ("store_load_full_session", Some(serde_json::to_string_pretty(&full).unwrap())),
        ("store_load_optional_fields_absent", Some(r#"{"version":1,"access_token":"a","refresh_token":"r","expires_at":10}"#.into())),
        ("store_load_optional_fields_null", Some(r#"{"version":1,"access_token":"a","refresh_token":"r","id_token":null,"account_id":null,"plan_type":null,"email":null,"expires_at":10}"#.into())),
        ("store_load_unknown_fields_ignored", Some(r#"{"version":1,"access_token":"a","refresh_token":"r","expires_at":10,"future":{"x":1}}"#.into())),
        ("store_load_future_version_is_no_session", Some(r#"{"version":2,"access_token":"a","refresh_token":"r","expires_at":10}"#.into())),
        ("store_load_missing_required_field_is_no_session", Some(r#"{"version":1,"access_token":"a","expires_at":10}"#.into())),
        ("store_load_wrong_type_is_no_session", Some(r#"{"version":1,"access_token":"a","refresh_token":"r","expires_at":"10"}"#.into())),
        ("store_load_corrupt_json_is_no_session", Some("{ not json".into())),
        ("store_load_negative_expiry_accepted", Some(r#"{"version":1,"access_token":"a","refresh_token":"r","expires_at":-5}"#.into())),
    ];
    for (name, file) in files {
        let path = store::token_file_path(&dir);
        let _ = std::fs::remove_file(&path);
        if let Some(text) = &file {
            std::fs::write(&path, text).unwrap();
        }
        let loaded = store::load(&dir).map(|t| stored_json(&t));
        out.push(case(name, STORE_RS, json!({"kind": "load", "file": file}), json!({"tokens": loaded})));
    }

    store::save(&dir, &full).unwrap();
    store::clear(&dir).unwrap();
    let cleared_exists = store::token_file_path(&dir).exists();
    let clear_again = store::clear(&dir).is_ok();
    out.push(case(
        "store_clear_removes_and_missing_is_success",
        STORE_RS,
        json!({"kind": "clear"}),
        json!({"exists_after_clear": cleared_exists, "second_clear_ok": clear_again}),
    ));

    for (name, expires_at, now, margin) in [
        ("expiry_well_before", 1_000_i64, 500_i64, 120_i64),
        ("expiry_inside_margin", 1_000, 881, 120),
        ("expiry_exactly_at_margin", 1_000, 880, 120),
        ("expiry_past", 1_000, 2_000, 120),
        ("expiry_zero_margin_equal", 1_000, 1_000, 0),
    ] {
        let tokens = StoredTokens { expires_at, ..minimal.clone() };
        out.push(case(
            name,
            STORE_RS,
            json!({"kind": "is_expired_at", "expires_at": expires_at, "now_unix": now, "margin_secs": margin}),
            json!({"expired": tokens.is_expired_at(now, margin)}),
        ));
    }

    let _ = std::fs::remove_dir_all(&dir);
    out
}

#[test]
#[ignore]
fn dump_fixtures() {
    let root = repo_root();
    let out = root.join("tests/fixtures/core-contracts/chatgpt-auth");
    let _ = std::fs::remove_dir_all(&out);
    std::fs::create_dir_all(&out).unwrap();
    let commit = git_head(&root);

    let mut cases = pkce_cases();
    cases.extend(callback_cases());
    cases.extend(jwt_cases());
    cases.extend(to_stored_cases());
    cases.extend(store_cases());

    let mut names = Vec::new();
    for c in &cases {
        let doc = json!({
            "name": c.name,
            "source": {"file": c.source, "commit": commit},
            "comparator": "json-exact",
            "input": c.input,
            "expected": c.expected,
        });
        std::fs::write(out.join(format!("{}.json", c.name)), serde_json::to_string_pretty(&doc).unwrap() + "\n").unwrap();
        names.push(c.name.clone());
    }

    let index = json!({
        "source": {"file": CHATGPT_RS, "commit": commit},
        "comparators": ["json-exact"],
        "comparator_notes": {
            "json-exact": "Call the function named by input.kind with the other input fields and compare the result with expected as a JSON tree.",
            "constants": {
                "client_id": CLIENT_ID,
                "issuer": ISSUER,
                "scopes": SCOPES,
                "callback_port": CALLBACK_PORT,
                "callback_path": CALLBACK_PATH,
                "callback_timeout_secs": CALLBACK_TIMEOUT.as_secs(),
                "originator": ORIGINATOR,
                "token_file_name": store::TOKEN_FILE_NAME,
                "token_file_version": TOKEN_FILE_VERSION,
                "refresh_safety_margin_secs": crate::core::auth::state::REFRESH_SAFETY_MARGIN_SECS,
                "terminal_token_errors": TERMINAL_TOKEN_ERRORS,
                "reauthorization_marker": REAUTHORIZATION_REQUIRED,
            },
            "authorize_url": "input.challenge is the S256 challenge of a verifier that never appears in the URL; the URL is compared as an exact string, parameter order included.",
            "to_stored": "input.response is the token endpoint's JSON body; input.previous_refresh is the refresh token being refreshed (null on a code exchange). expected is {ok: stored session as serialised} or {err: message}.",
            "save": "expected.text is the exact file bytes (serde pretty print, fields in declaration order, None as null, no trailing newline); expected.mode is the permission bits on Unix (0o600 = 384), null elsewhere.",
            "load": "input.file is the file's text (null = absent); expected.tokens is the session read back, or null when the file reads as no session.",
            "not_captured": "exchange_code and refresh_tokens POST to the pinned https://auth.openai.com/oauth/token; their request form and error classification (an `error` string or `error.code` in TERMINAL_TOKEN_ERRORS → `reauthorization required: <code>`, anything else → `token request rejected (<status>): <body>`) are pinned by unit tests in the port, not by these fixtures."
        },
        "cases": names,
    });
    std::fs::write(out.join("index.json"), serde_json::to_string_pretty(&index).unwrap() + "\n").unwrap();
    eprintln!("wrote {} chatgpt-auth fixtures to {}", names.len(), out.display());
}
