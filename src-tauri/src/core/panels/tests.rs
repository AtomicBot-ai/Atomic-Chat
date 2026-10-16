//! Panel host tests.
//!
//! The manifest cases are checked against the same fixtures
//! `tests/panel-contract.test.mjs` uses, so the Rust validator and the JSON
//! schema cannot drift apart without one of the two suites failing. The path
//! cases are the ones that matter most: every refusal here is an attempt to
//! read something outside the panel's folder.

use super::manifest::{parse_manifest, PanelManifest, ALWAYS_ALLOWED, CORE_PERMISSIONS};
use super::protocol::{serve, split_request, PANEL_CSP};
use super::registry::PanelRegistry;
use super::resolve::{resolve_panel_file, RefusedPath};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::http::Request;

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/panels")
}

fn contract_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/panel-contract")
}

/// A panels root with one working panel in it.
fn temp_root(name: &str) -> PathBuf {
    let root =
        std::env::temp_dir().join(format!("radium-panel-tests-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).expect("create panels root");
    root
}

fn write_panel(root: &Path, id: &str, manifest: &str, entry_body: &str) -> PathBuf {
    let dir = root.join(id);
    fs::create_dir_all(&dir).expect("create panel dir");
    fs::write(dir.join("panel.json"), manifest).expect("write manifest");
    fs::write(dir.join("index.html"), entry_body).expect("write entry");
    dir
}

fn good_manifest(id: &str) -> String {
    format!(r#"{{ "contract": 1, "id": "{id}", "name": "Test panel", "entry": "index.html" }}"#)
}

#[test]
fn the_conformance_fixture_is_accepted() {
    let source = fs::read_to_string(fixtures().join("conformance/panel.json")).unwrap();
    let manifest =
        parse_manifest(&source, Some("contract-conformance")).expect("fixture must pass");
    assert_eq!(manifest.contract, 1);
    assert_eq!(manifest.id, "contract-conformance");
    assert!(manifest.allows("storage"));
    assert!(manifest.allows("mcp.read"));
    // Declared permissions are the whole grant: nothing else is implied.
    assert!(!manifest.allows("mcp.call"));
    assert!(manifest.allows_server("fixture-server"));
    assert!(!manifest.allows_server("some-other-server"));
}

#[test]
fn every_invalid_fixture_is_rejected_for_its_own_reason() {
    // Mirrors the expectations in tests/panel-contract.test.mjs; if the schema
    // and this validator disagree about a case, one of the two suites fails.
    let cases = [
        ("missing-contract.json", "missing `contract`"),
        ("wrong-contract.json", "this host implements 1"),
        ("bad-id.json", "`id` must be lowercase"),
        ("traversal-entry.json", "inside the panel folder"),
        ("unknown-key.json", "panel.json is not valid"),
        ("mcp-without-servers.json", "`mcpServers` is required"),
    ];
    let dir = fixtures().join("invalid");
    let on_disk = fs::read_dir(&dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "json"))
        .count();
    assert_eq!(
        on_disk,
        cases.len(),
        "every invalid fixture needs a case here"
    );

    for (file, expected) in cases {
        let source = fs::read_to_string(dir.join(file)).unwrap();
        let errors = parse_manifest(&source, None).expect_err(&format!("{file} must be rejected"));
        assert!(
            errors.iter().any(|error| error.contains(expected)),
            "{file} should mention {expected:?}, got {errors:?}"
        );
    }
}

#[test]
fn the_folder_name_has_to_match_the_id() {
    let errors = parse_manifest(&good_manifest("one-name"), Some("another-name")).unwrap_err();
    assert!(errors
        .iter()
        .any(|e| e.contains("must match the folder name")));
}

#[test]
fn core_permissions_are_the_portable_set_and_everything_else_is_namespaced() {
    let base = |permissions: &str| {
        format!(
            r#"{{ "contract": 1, "id": "perm-panel", "name": "P", "entry": "index.html", "permissions": {permissions} }}"#
        )
    };
    for permission in CORE_PERMISSIONS {
        let extra = if permission.starts_with("mcp") {
            r#", "mcpServers": []"#
        } else {
            ""
        };
        let source = format!(
            r#"{{ "contract": 1, "id": "perm-panel", "name": "P", "entry": "index.html", "permissions": ["{permission}"]{extra} }}"#
        );
        assert!(
            parse_manifest(&source, None).is_ok(),
            "{permission} must be accepted"
        );
    }
    // Another host's capability, namespaced: expressible, so a panel stays
    // installable where it is understood.
    assert!(parse_manifest(&base(r#"["cdc:usage.read"]"#), None).is_ok());
    // The same capability unprefixed is refused, because unprefixed names are
    // reserved for the portable core.
    assert!(parse_manifest(&base(r#"["usage.read"]"#), None).is_err());
    assert!(parse_manifest(&base(r#"["storage", "storage"]"#), None).is_err());
}

#[test]
fn asking_for_mcp_without_an_allowlist_is_refused_but_an_empty_one_is_not() {
    let with = r#"{ "contract": 1, "id": "mcp-panel", "name": "P", "entry": "index.html", "permissions": ["mcp.call"], "mcpServers": [] }"#;
    let without = r#"{ "contract": 1, "id": "mcp-panel", "name": "P", "entry": "index.html", "permissions": ["mcp.call"] }"#;
    assert!(
        parse_manifest(with, None).is_ok(),
        "an empty allowlist is a deliberate nothing"
    );
    assert!(parse_manifest(without, None).is_err());
}

#[test]
fn a_traversing_request_is_refused_rather_than_clamped() {
    let root = temp_root("traversal");
    let panel = write_panel(
        &root,
        "traversal-panel",
        &good_manifest("traversal-panel"),
        "<p>hi",
    );
    fs::write(root.join("secret.txt"), "not yours").unwrap();

    for request in [
        "/../secret.txt",
        "/../../etc/passwd",
        "/nested/../../secret.txt",
    ] {
        let refusal = resolve_panel_file(&panel, request, "index.html").unwrap_err();
        assert_eq!(
            refusal,
            RefusedPath::Suspicious,
            "{request} must be refused outright"
        );
    }
    // The entry itself still resolves.
    assert!(resolve_panel_file(&panel, "/", "index.html").is_ok());
    let _ = fs::remove_dir_all(&root);
}

#[cfg(unix)]
#[test]
fn a_symlink_out_of_the_folder_is_refused_by_containment() {
    let root = temp_root("symlink");
    let panel = write_panel(
        &root,
        "symlink-panel",
        &good_manifest("symlink-panel"),
        "<p>hi",
    );
    let outside = root.join("outside.html");
    fs::write(&outside, "<p>not yours").unwrap();
    std::os::unix::fs::symlink(&outside, panel.join("escape.html")).unwrap();

    // The path looks innocent; only canonicalising and checking containment
    // catches it, which is exactly why resolve does both.
    let refusal = resolve_panel_file(&panel, "/escape.html", "index.html").unwrap_err();
    assert_eq!(refusal, RefusedPath::Escapes);
    let _ = fs::remove_dir_all(&root);
}

#[cfg(unix)]
#[test]
fn a_symlinked_manifest_makes_the_panel_broken_not_loaded() {
    let root = temp_root("symlink-manifest");
    let elsewhere = root.join("elsewhere.json");
    fs::write(&elsewhere, good_manifest("sneaky-panel")).unwrap();
    let dir = root.join("sneaky-panel");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("index.html"), "<p>hi").unwrap();
    std::os::unix::fs::symlink(&elsewhere, dir.join("panel.json")).unwrap();

    let registry = PanelRegistry::load(&root).unwrap();
    assert!(registry.get("sneaky-panel").is_none());
    assert!(registry
        .broken()
        .iter()
        .any(|panel| panel.id == "sneaky-panel"
            && panel.errors.iter().any(|e| e.contains("symlink"))));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_broken_panel_is_reported_rather_than_hidden() {
    let root = temp_root("broken");
    write_panel(&root, "good-panel", &good_manifest("good-panel"), "<p>hi");
    // Valid JSON, invalid manifest.
    write_panel(
        &root,
        "bad-panel",
        r#"{ "contract": 1, "id": "bad-panel" }"#,
        "<p>hi",
    );
    // Promises an entry it does not have.
    let missing = root.join("missing-entry");
    fs::create_dir_all(&missing).unwrap();
    fs::write(
        missing.join("panel.json"),
        r#"{ "contract": 1, "id": "missing-entry", "name": "P", "entry": "nope.html" }"#,
    )
    .unwrap();

    let registry = PanelRegistry::load(&root).unwrap();
    assert!(registry.get("good-panel").is_some());
    assert_eq!(registry.installed().count(), 1);
    let broken: Vec<&str> = registry.broken().iter().map(|p| p.id.as_str()).collect();
    assert!(broken.contains(&"bad-panel"));
    assert!(broken.contains(&"missing-entry"));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn served_panel_files_carry_the_restrictive_csp() {
    let root = temp_root("serve");
    write_panel(
        &root,
        "served-panel",
        &good_manifest("served-panel"),
        "<p>hello",
    );

    let response = serve(&root, &contract_dir(), "served-panel", "/");
    assert_eq!(response.status(), 200);
    let csp = response
        .headers()
        .get("Content-Security-Policy")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    assert!(
        csp.contains("connect-src 'none'"),
        "a panel must not reach the network"
    );
    assert!(
        !csp.contains("unsafe-eval"),
        "unsafe-eval was dropped app-wide; panels do not get it back"
    );
    assert_eq!(
        response.headers().get("Content-Type").unwrap(),
        "text/html; charset=utf-8"
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn the_frozen_contract_files_are_served_to_every_panel() {
    let root = temp_root("shared");
    write_panel(
        &root,
        "shared-panel",
        &good_manifest("shared-panel"),
        "<p>hi",
    );

    for (file, expected) in [
        ("/panel-sdk.js", "text/javascript; charset=utf-8"),
        ("/panel-theme.css", "text/css; charset=utf-8"),
    ] {
        let response = serve(&root, &contract_dir(), "shared-panel", file);
        assert_eq!(response.status(), 200, "{file} must be served");
        assert_eq!(response.headers().get("Content-Type").unwrap(), expected);
    }
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn an_unknown_panel_and_a_refused_path_say_nothing_useful() {
    let root = temp_root("refusals");
    write_panel(&root, "known-panel", &good_manifest("known-panel"), "<p>hi");

    assert_eq!(
        serve(&root, &contract_dir(), "no-such-panel", "/").status(),
        404
    );
    assert_eq!(
        serve(&root, &contract_dir(), "known-panel", "/../secret").status(),
        403
    );
    assert_eq!(
        serve(&root, &contract_dir(), "known-panel", "/nope.html").status(),
        404
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn both_url_shapes_resolve_to_the_same_panel() {
    let build = |uri: &str| {
        let request = Request::builder().uri(uri).body(Vec::new()).unwrap();
        split_request(&request)
    };

    // macOS and Linux.
    assert_eq!(
        build("panel://my-panel/index.html"),
        Some(("my-panel".to_string(), "/index.html".to_string()))
    );
    // Windows serves custom schemes over http://<scheme>.localhost.
    assert_eq!(
        build("http://panel.localhost/my-panel/index.html"),
        Some(("my-panel".to_string(), "/index.html".to_string()))
    );
    assert_eq!(
        build("http://panel.localhost/my-panel"),
        Some(("my-panel".to_string(), "/".to_string()))
    );
    assert_eq!(build("http://panel.localhost/"), None);
}

#[test]
fn the_csp_constant_is_what_the_spec_promises() {
    for directive in [
        "default-src 'self'",
        "connect-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
    ] {
        assert!(PANEL_CSP.contains(directive), "missing {directive}");
    }
}

// ---------------------------------------------------------------------------
// Bridge: the authorisation rules, driven against a stub host so the tests say
// what was allowed and what reached the app, without needing an app handle.
// ---------------------------------------------------------------------------

use super::bridge::{dispatch, PanelHost, PanelTool};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::Mutex;

#[derive(Default)]
struct StubHost {
    tools: Vec<PanelTool>,
    /// Every (server, tool) the bridge actually asked for, in order. If a
    /// denial leaks, it shows up here.
    calls: Mutex<Vec<(String, String)>>,
    /// Servers the bridge passed to `list_tools`.
    listed_for: Mutex<Vec<Vec<String>>>,
    storage: Mutex<Vec<(String, String, Value)>>,
}

impl StubHost {
    fn with_tools(tools: &[(&str, &str)]) -> Self {
        Self {
            tools: tools
                .iter()
                .map(|(name, server)| PanelTool {
                    name: (*name).to_string(),
                    server: (*server).to_string(),
                    description: None,
                })
                .collect(),
            ..Default::default()
        }
    }
}

#[async_trait]
impl PanelHost for StubHost {
    fn app_version(&self) -> String {
        "1.2.3".to_string()
    }
    fn platform(&self) -> String {
        "test".to_string()
    }
    async fn theme(&self) -> String {
        "dark".to_string()
    }
    async fn list_tools(&self, servers: &[String]) -> Result<Vec<PanelTool>, String> {
        self.listed_for.lock().unwrap().push(servers.to_vec());
        Ok(self
            .tools
            .iter()
            .filter(|tool| servers.contains(&tool.server))
            .cloned()
            .collect())
    }
    async fn call_tool(&self, server: &str, tool: &str, _args: Value) -> Result<Value, String> {
        self.calls
            .lock()
            .unwrap()
            .push((server.to_string(), tool.to_string()));
        Ok(json!({ "called": tool }))
    }
    async fn storage_get(&self, panel_id: &str, key: Option<&str>) -> Result<Value, String> {
        let storage = self.storage.lock().unwrap();
        match key {
            Some(key) => Ok(storage
                .iter()
                .find(|(id, k, _)| id == panel_id && k == key)
                .map(|(_, _, value)| value.clone())
                .unwrap_or(Value::Null)),
            None => Ok(json!({})),
        }
    }
    async fn storage_set(&self, panel_id: &str, key: &str, value: Value) -> Result<(), String> {
        self.storage
            .lock()
            .unwrap()
            .push((panel_id.to_string(), key.to_string(), value));
        Ok(())
    }
}

fn manifest_with(permissions: &str, servers: &str) -> PanelManifest {
    let source = format!(
        r#"{{ "contract": 1, "id": "bridge-panel", "name": "B", "entry": "index.html", "permissions": {permissions}, "mcpServers": {servers} }}"#
    );
    parse_manifest(&source, None).expect("fixture manifest must be valid")
}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(future)
}

#[test]
fn an_unimplemented_method_reads_as_unknown_not_unauthorised() {
    let manifest = manifest_with("[]", "[]");
    let host = StubHost::default();
    let response = block_on(dispatch(&manifest, "does.not.exist", &json!({}), &host));
    assert_eq!(response.code(), Some("unknown_method"));
    // A panel written against a newer contract must learn the host is old,
    // not that it asked for the wrong permission.
    assert!(response.error().unwrap().contains("does.not.exist"));
}

#[test]
fn the_four_always_allowed_methods_need_no_permission() {
    let manifest = manifest_with("[]", "[]");
    let host = StubHost::default();
    for method in ALWAYS_ALLOWED {
        let response = block_on(dispatch(&manifest, method, &json!({}), &host));
        assert!(response.is_ok(), "{method} must not need a permission");
    }
    let info = block_on(dispatch(&manifest, "host.info", &json!({}), &host));
    assert_eq!(info.result().unwrap()["theme"], json!("dark"));
    assert_eq!(info.result().unwrap()["contract"], json!(1));
}

#[test]
fn an_undeclared_permission_is_denied_and_the_message_names_it() {
    let manifest = manifest_with("[]", "[]");
    let host = StubHost::default();
    for (method, permission) in [
        ("storage.get", "storage"),
        ("storage.set", "storage"),
        ("mcp.listTools", "mcp.read"),
        ("mcp.callTool", "mcp.call"),
    ] {
        let response = block_on(dispatch(&manifest, method, &json!({"key": "k"}), &host));
        assert_eq!(response.code(), Some("permission_denied"), "{method}");
        let error = response.error().unwrap();
        assert!(
            error.contains(permission),
            "{method} should name {permission}: {error}"
        );
    }
    // Nothing reached the app behind the denials.
    assert!(host.calls.lock().unwrap().is_empty());
    assert!(host.listed_for.lock().unwrap().is_empty());
    assert!(host.storage.lock().unwrap().is_empty());
}

#[test]
fn storage_is_namespaced_to_the_panel_that_wrote_it() {
    let host = StubHost::default();
    let one = manifest_with(r#"["storage"]"#, "[]");
    let mut two = one.clone();
    two.id = "other-panel".to_string();

    block_on(dispatch(
        &one,
        "storage.set",
        &json!({"key": "k", "value": 1}),
        &host,
    ));
    let mine = block_on(dispatch(&one, "storage.get", &json!({"key": "k"}), &host));
    let theirs = block_on(dispatch(&two, "storage.get", &json!({"key": "k"}), &host));

    assert_eq!(mine.result().unwrap(), &json!(1));
    // The other panel sees nothing, even for the same key.
    assert_eq!(theirs.result().unwrap(), &json!(null));
    assert_eq!(host.storage.lock().unwrap()[0].0, "bridge-panel");
}

#[test]
fn listing_tools_is_scoped_to_the_servers_the_manifest_names() {
    let host = StubHost::with_tools(&[("allowed-tool", "server-a"), ("other-tool", "server-b")]);
    let manifest = manifest_with(r#"["mcp.read"]"#, r#"["server-a"]"#);

    let response = block_on(dispatch(&manifest, "mcp.listTools", &json!({}), &host));
    let tools = response.result().unwrap().as_array().unwrap();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0]["server"], json!("server-a"));
    // The bridge asked only for the allowlisted server, so a host that
    // ignored the filter still could not widen it here.
    assert_eq!(
        host.listed_for.lock().unwrap()[0],
        vec!["server-a".to_string()]
    );
}

#[test]
fn naming_a_server_outside_the_allowlist_is_denied_before_anything_is_called() {
    let host = StubHost::with_tools(&[("other-tool", "server-b")]);
    let manifest = manifest_with(r#"["mcp.call"]"#, r#"["server-a"]"#);

    let response = block_on(dispatch(
        &manifest,
        "mcp.callTool",
        &json!({"name": "other-tool", "server": "server-b"}),
        &host,
    ));
    assert_eq!(response.code(), Some("permission_denied"));
    assert!(response.error().unwrap().contains("server-b"));
    assert!(
        host.calls.lock().unwrap().is_empty(),
        "nothing may be called"
    );
}

#[test]
fn an_unqualified_tool_resolves_only_within_the_allowlist() {
    let host = StubHost::with_tools(&[("shared-tool", "server-a"), ("shared-tool", "server-b")]);
    let allowed_one = manifest_with(r#"["mcp.call"]"#, r#"["server-a"]"#);

    // Unambiguous inside the allowlist even though another server offers the
    // same name, because listing never left the allowlist.
    let response = block_on(dispatch(
        &allowed_one,
        "mcp.callTool",
        &json!({"name": "shared-tool"}),
        &host,
    ));
    assert!(response.is_ok());
    assert_eq!(host.calls.lock().unwrap()[0].0, "server-a");

    // With both servers allowed the name really is ambiguous, and the bridge
    // refuses rather than picking one.
    let allowed_both = manifest_with(r#"["mcp.call"]"#, r#"["server-a", "server-b"]"#);
    let ambiguous = block_on(dispatch(
        &allowed_both,
        "mcp.callTool",
        &json!({"name": "shared-tool"}),
        &host,
    ));
    assert!(!ambiguous.is_ok());
    assert!(ambiguous.error().unwrap().contains("Pass `server`"));
    assert_eq!(
        host.calls.lock().unwrap().len(),
        1,
        "no second call was made"
    );
}

#[test]
fn an_unknown_tool_is_a_handler_error_not_a_denial() {
    let host = StubHost::with_tools(&[("real-tool", "server-a")]);
    let manifest = manifest_with(r#"["mcp.call"]"#, r#"["server-a"]"#);
    let response = block_on(dispatch(
        &manifest,
        "mcp.callTool",
        &json!({"name": "imaginary"}),
        &host,
    ));
    // The panel asked correctly and was allowed; the tool simply is not there.
    assert_eq!(response.code(), Some("handler_error"));
    assert!(host.calls.lock().unwrap().is_empty());
}

#[test]
fn an_empty_allowlist_grants_nothing_even_with_the_permission() {
    let host = StubHost::with_tools(&[("a-tool", "server-a")]);
    let manifest = manifest_with(r#"["mcp.read", "mcp.call"]"#, "[]");

    let listed = block_on(dispatch(&manifest, "mcp.listTools", &json!({}), &host));
    assert_eq!(listed.result().unwrap().as_array().unwrap().len(), 0);

    let called = block_on(dispatch(
        &manifest,
        "mcp.callTool",
        &json!({"name": "a-tool"}),
        &host,
    ));
    assert!(!called.is_ok());
    assert!(host.calls.lock().unwrap().is_empty());
}

// ---------------------------------------------------------------------------
// Install: what a folder from someone else is allowed to bring with it.
// ---------------------------------------------------------------------------

use super::commands::install_from;

#[test]
fn installing_validates_the_manifest_before_copying_anything() {
    let root = temp_root("install-invalid");
    let source = temp_root("install-invalid-src").join("staging");
    fs::create_dir_all(&source).unwrap();
    // Valid JSON, invalid manifest: no name, no entry.
    fs::write(
        source.join("panel.json"),
        r#"{ "contract": 1, "id": "staging" }"#,
    )
    .unwrap();
    fs::write(source.join("index.html"), "<p>hi").unwrap();

    let error = install_from(&root, &source).unwrap_err();
    assert!(error.contains("Invalid panel.json"), "got: {error}");
    // Nothing half-installed: the destination was never created.
    assert!(!root.join("staging").join("index.html").exists() || root.join("staging") == source);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn installing_requires_the_folder_name_to_match_the_id() {
    let root = temp_root("install-mismatch");
    let source = temp_root("install-mismatch-src").join("wrong-folder");
    fs::create_dir_all(&source).unwrap();
    fs::write(source.join("panel.json"), good_manifest("other-id")).unwrap();
    fs::write(source.join("index.html"), "<p>hi").unwrap();

    let error = install_from(&root, &source).unwrap_err();
    assert!(error.contains("must match the folder name"), "got: {error}");
    let _ = fs::remove_dir_all(&root);
}

#[cfg(unix)]
#[test]
fn installing_refuses_a_folder_containing_a_symlink() {
    let root = temp_root("install-symlink");
    let staging = temp_root("install-symlink-src");
    let outside = staging.join("secret.txt");
    fs::write(&outside, "not yours").unwrap();
    let source = staging.join("sneaky-copy");
    fs::create_dir_all(&source).unwrap();
    fs::write(source.join("panel.json"), good_manifest("sneaky-copy")).unwrap();
    fs::write(source.join("index.html"), "<p>hi").unwrap();
    // A link in a downloaded folder would otherwise pull in anything the user
    // can read, into a directory the panel is then served from.
    std::os::unix::fs::symlink(&outside, source.join("link.txt")).unwrap();

    let error = install_from(&root, &source).unwrap_err();
    assert!(error.contains("symbolic link"), "got: {error}");
    // And the partial copy is cleaned up rather than left serving.
    assert!(!root.join("sneaky-copy").join("index.html").exists());
    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&staging);
}

#[test]
fn installing_a_panel_onto_itself_is_refused_rather_than_deleting_it() {
    // Found by a test that staged its source inside the panels root: the
    // replace step removes the destination first, so without the guard this
    // deleted the source and then copied nothing.
    let root = temp_root("install-self");
    let panel = write_panel(&root, "self-panel", &good_manifest("self-panel"), "<p>hi");

    let error = install_from(&root, &panel).unwrap_err();
    assert!(error.contains("already installed"), "got: {error}");
    // The panel is still there, which is the whole point.
    assert!(panel.join("index.html").is_file());
    assert!(PanelRegistry::load(&root)
        .unwrap()
        .get("self-panel")
        .is_some());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_good_folder_installs_and_is_then_listed() {
    let root = temp_root("install-good");
    let source = temp_root("install-good-src");
    let panel_dir = source.join("nice-panel");
    fs::create_dir_all(&panel_dir).unwrap();
    fs::write(panel_dir.join("panel.json"), good_manifest("nice-panel")).unwrap();
    fs::write(panel_dir.join("index.html"), "<p>hi").unwrap();
    fs::create_dir_all(panel_dir.join("assets")).unwrap();
    fs::write(panel_dir.join("assets").join("style.css"), "body{}").unwrap();

    let manifest = install_from(&root, &panel_dir).expect("should install");
    assert_eq!(manifest.id, "nice-panel");
    // Nested files come along.
    assert!(root
        .join("nice-panel")
        .join("assets")
        .join("style.css")
        .is_file());

    let registry = PanelRegistry::load(&root).unwrap();
    assert!(registry.get("nice-panel").is_some());
    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&source);
}
