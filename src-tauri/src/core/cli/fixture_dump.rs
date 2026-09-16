//! Golden-fixture emitter for the agent-integration writers.
//!
//! `integrations::configure` dispatches to the `configure_*` functions in
//! `core::system::commands`; each of them writes one or more files under the
//! user's home directory. A TypeScript port of those writers lives in the
//! sibling `atomic-chat-core` repo, and "the file looks about right" is not a
//! contract — indentation, key order, trailing newlines and what survives a
//! rerun all have to match byte for byte.
//!
//! So: for every agent, run the real writer against a throwaway HOME, walk the
//! tree afterwards and record every file verbatim. Same shape and same
//! discipline as the `dump_fixtures` emitters in
//! `plugins/tauri-plugin-llamacpp-upstream/src/args.rs` and
//! `core/server/state_file.rs`.
//!
//! Test-only: nothing here is compiled into the app, and no behaviour in
//! `commands.rs` is touched.
//!
//! Emit with:
//! ```text
//! cargo test --no-default-features --features test-tauri,cli --lib -- --ignored dump_fixtures
//! ```

use serde_json::json;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::integrations;

/// Bare server origin the Launch page would hand the agent.
const BASE_URL: &str = "http://127.0.0.1:1337";
const PREFIX: &str = "/v1";
const MODEL: &str = "AtomicChat/Qwen3.5-9B-GGUF";
const KEY: &str = "sk-atomic-fixture-key";

/// Every environment variable a `configure_*` function reads, directly or
/// through a helper. Saved and restored around each case so a dump can never
/// leak into the developer's real environment — or their real home directory.
const MANAGED_ENV: &[&str] = &[
    "HOME",
    "USERPROFILE",
    "SHELL",
    "PATH",
    "DSH_HOME",
    "OPENCLAW_CONFIG_PATH",
    "ATOMIC_AGENT_STATE_DIR",
    "HERMES_HOME",
];

/// Environment variables are process-global, so cases must not overlap.
static ENV_LOCK: Mutex<()> = Mutex::new(());

struct EnvGuard {
    _lock: std::sync::MutexGuard<'static, ()>,
    saved: Vec<(&'static str, Option<String>)>,
}

impl EnvGuard {
    fn acquire() -> Self {
        let lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let saved = MANAGED_ENV
            .iter()
            .map(|k| (*k, std::env::var(k).ok()))
            .collect();
        Self { _lock: lock, saved }
    }

    fn set(&self, key: &str, value: &str) {
        std::env::set_var(key, value);
    }

    fn unset(&self, key: &str) {
        std::env::remove_var(key);
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (key, value) in &self.saved {
            match value {
                Some(v) => std::env::set_var(key, v),
                None => std::env::remove_var(key),
            }
        }
    }
}

// ── case model ─────────────────────────────────────────────────────────────

/// How the case is executed. Every agent but Cline writes files; Cline shells
/// out to `cline auth`, so its cases record the spawned argv instead.
#[derive(Clone, Copy, PartialEq)]
enum Mode {
    /// Walk the fake home afterwards and record every file.
    Files,
    /// Put a recording stub named `cline` on PATH; it exits 0.
    ClineOk,
    /// The stub exits 1 with a message on stderr.
    ClineFail,
    /// PATH holds no `cline` at all, so the spawn itself fails.
    ClineMissing,
}

struct Case {
    name: String,
    agent: &'static str,
    /// Every invocation, in order. More than one proves idempotence; differing
    /// arguments across runs prove what a *changed* rerun preserves or clears.
    runs: Vec<(String, String, String)>,
    /// Files written into the fake home before the first invocation.
    seed: BTreeMap<String, String>,
    /// Value of `$SHELL`, which picks the rc file for the env-var agents.
    shell: &'static str,
    mode: Mode,
}

fn default_url(agent: &'static str) -> String {
    let a = integrations::find(agent).expect("agent in catalog");
    integrations::api_url_for(a, BASE_URL, PREFIX)
}

fn case(agent: &'static str, name: &str) -> Case {
    Case {
        name: format!("{}__{}", agent.replace('-', "_"), name),
        agent,
        runs: vec![(default_url(agent), MODEL.to_string(), KEY.to_string())],
        seed: BTreeMap::new(),
        shell: "/bin/zsh",
        mode: Mode::Files,
    }
}

impl Case {
    fn key(mut self, key: &str) -> Self {
        for run in &mut self.runs {
            run.2 = key.to_string();
        }
        self
    }

    fn model(mut self, model: &str) -> Self {
        for run in &mut self.runs {
            run.1 = model.to_string();
        }
        self
    }

    fn url(mut self, url: &str) -> Self {
        for run in &mut self.runs {
            run.0 = url.to_string();
        }
        self
    }

    /// Run `configure` twice with identical arguments.
    fn twice(mut self) -> Self {
        let first = self.runs[0].clone();
        self.runs.insert(0, first);
        self
    }

    /// Prepend an invocation with different arguments, so the recorded state is
    /// what a *changed* rerun leaves behind. Call it AFTER `key`/`model`/`url`,
    /// which rewrite every run already queued.
    fn after(mut self, url: &str, model: &str, key: &str) -> Self {
        self.runs
            .insert(0, (url.to_string(), model.to_string(), key.to_string()));
        self
    }

    fn seed(mut self, path: &str, body: &str) -> Self {
        self.seed.insert(path.to_string(), body.to_string());
        self
    }

    fn shell(mut self, shell: &'static str) -> Self {
        self.shell = shell;
        self
    }

    fn mode(mut self, mode: Mode) -> Self {
        self.mode = mode;
        self
    }
}

// ── filesystem helpers ─────────────────────────────────────────────────────

fn write_file(root: &Path, rel: &str, body: &str) {
    let path = root.join(rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("create seed parent");
    }
    std::fs::write(&path, body).expect("write seed file");
}

/// Collect every regular file under `dir`, keyed by its `/`-separated path
/// relative to the fake home.
fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut paths: Vec<PathBuf> = entries.filter_map(|e| e.ok()).map(|e| e.path()).collect();
    paths.sort();
    for path in paths {
        if path.is_dir() {
            walk(root, &path, out);
            continue;
        }
        let rel = path
            .strip_prefix(root)
            .expect("inside fake home")
            .to_string_lossy()
            .replace('\\', "/");
        let body = match std::fs::read(&path) {
            Ok(bytes) => match String::from_utf8(bytes) {
                Ok(text) => text,
                Err(e) => format!("<non-utf8: {} bytes>", e.into_bytes().len()),
            },
            Err(e) => format!("<unreadable: {}>", e),
        };
        out.insert(rel, body);
    }
}

/// Replace values that cannot be reproduced by a port: the absolute fake-home
/// path and any wall-clock timestamp.
fn scrub(text: &str, home: &str) -> String {
    scrub_timestamps(&text.replace(home, "<home>"))
}

fn scrub_timestamps(text: &str) -> String {
    const KEY_: &str = "\"createdAt\": \"";
    let mut out = String::new();
    let mut rest = text;
    while let Some(i) = rest.find(KEY_) {
        let after = i + KEY_.len();
        match rest[after..].find('"') {
            Some(j) => {
                out.push_str(&rest[..after]);
                out.push_str("<timestamp>");
                rest = &rest[after + j..];
            }
            None => break,
        }
    }
    out.push_str(rest);
    out
}

/// `std::io::Error` messages differ per platform, so only the prefix is kept.
fn scrub_spawn_error(message: &str) -> String {
    const PREFIX_: &str = "Failed to spawn 'cline': ";
    match message.strip_prefix(PREFIX_) {
        Some(_) => format!("{}<os-error>", PREFIX_),
        None => message.to_string(),
    }
}

/// Write a `cline` stub that appends its argv to `$ATOMIC_FIXTURE_CLINE_RECORD`.
#[cfg(unix)]
fn write_cline_stub(bin_dir: &Path, fail: bool) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(bin_dir).expect("create stub bin dir");
    let script = format!(
        "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\" >> \"$ATOMIC_FIXTURE_CLINE_RECORD\"; done\n{}",
        if fail {
            "printf 'Error: provider openai-compatible rejected the credentials\\n' >&2\nexit 1\n"
        } else {
            "exit 0\n"
        }
    );
    let path = bin_dir.join("cline");
    std::fs::write(&path, script).expect("write cline stub");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
        .expect("chmod cline stub");
}

#[cfg(not(unix))]
fn write_cline_stub(_bin_dir: &Path, _fail: bool) {}

// ── the runner ─────────────────────────────────────────────────────────────

struct Outcome {
    files: BTreeMap<String, String>,
    error: Option<String>,
    spawn: Option<Vec<String>>,
}

fn run_case(case: &Case, sandbox: &Path) -> Outcome {
    let home = sandbox.join("homes").join(&case.name);
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).expect("create fake home");
    let home_str = home.to_string_lossy().into_owned();

    for (rel, body) in &case.seed {
        write_file(&home, rel, body);
    }

    let guard = EnvGuard::acquire();
    guard.set("HOME", &home_str);
    guard.set("USERPROFILE", &home_str);
    guard.set("SHELL", case.shell);
    // `dsh` otherwise probes an interactive login shell for `DSH_HOME`. Pinning
    // it to the default location keeps the case hermetic without changing which
    // path is written.
    guard.set("DSH_HOME", &home.join(".dsh").to_string_lossy());
    guard.unset("OPENCLAW_CONFIG_PATH");
    guard.unset("ATOMIC_AGENT_STATE_DIR");
    guard.unset("HERMES_HOME");

    // Cline shells out instead of writing files. Point PATH at a stub so no real
    // `cline` on the developer's machine can be invoked (which would rewrite
    // their actual Cline credentials).
    let record = sandbox.join("spawns").join(format!("{}.argv", case.name));
    if case.mode != Mode::Files {
        let bin = sandbox.join("bin").join(&case.name);
        std::fs::create_dir_all(&bin).expect("create stub bin dir");
        std::fs::create_dir_all(record.parent().unwrap()).expect("create spawn record dir");
        let _ = std::fs::remove_file(&record);
        if case.mode != Mode::ClineMissing {
            write_cline_stub(&bin, case.mode == Mode::ClineFail);
        }
        guard.set("PATH", &bin.to_string_lossy());
        std::env::set_var("ATOMIC_FIXTURE_CLINE_RECORD", &record);
        // `apply_login_path` overrides PATH with the login shell's, so point
        // $SHELL at nothing: the probe fails and the stub PATH survives.
        guard.set("SHELL", "/nonexistent/atomic-fixture-shell");
    }

    let agent = integrations::find(case.agent).expect("agent in catalog");
    let mut error = None;
    for (url, model, key) in &case.runs {
        error = integrations::configure(agent, url, model, key).err();
    }

    let spawn = if case.mode != Mode::Files {
        std::env::remove_var("ATOMIC_FIXTURE_CLINE_RECORD");
        std::fs::read_to_string(&record)
            .ok()
            .map(|text| text.lines().map(str::to_string).collect())
    } else {
        None
    };

    drop(guard);

    let mut raw = BTreeMap::new();
    walk(&home, &home, &mut raw);
    let files = raw
        .into_iter()
        .map(|(k, v)| (k, scrub(&v, &home_str)))
        .collect();

    Outcome {
        files,
        error: error.map(|e| scrub_spawn_error(&scrub(&e, &home_str))),
        spawn,
    }
}

// ── the scenarios ──────────────────────────────────────────────────────────

fn cases() -> Vec<Case> {
    let mut v: Vec<Case> = Vec::new();

    // ── kilo: ~/.config/kilo/kilo.jsonc, parsed as JSON5 ──────────────────
    v.push(case("kilo", "fresh"));
    v.push(case("kilo", "rerun").twice());
    v.push(case("kilo", "empty_key").key(""));
    v.push(
        case("kilo", "existing_other_provider").seed(
            ".config/kilo/kilo.jsonc",
            "{\n  \"$schema\": \"https://app.kilo.ai/config.json\",\n  \"theme\": \"dracula\",\n  \"provider\": {\n    \"openrouter\": {\n      \"npm\": \"@openrouter/ai-sdk-provider\",\n      \"options\": { \"apiKey\": \"sk-or-user\" }\n    }\n  },\n  \"model\": \"openrouter/anthropic/claude-sonnet-4\"\n}\n",
        ),
    );
    v.push(case("kilo", "jsonc_comments_dropped").seed(
        ".config/kilo/kilo.jsonc",
        "{\n  // my kilo config\n  \"theme\": \"dracula\", // trailing comma next\n}\n",
    ));
    v.push(case("kilo", "empty_file").seed(".config/kilo/kilo.jsonc", ""));
    v.push(case("kilo", "provider_not_object_replaced").seed(
        ".config/kilo/kilo.jsonc",
        "{\n  \"provider\": \"nonsense\"\n}\n",
    ));
    v.push(case("kilo", "custom_schema_preserved").seed(
        ".config/kilo/kilo.jsonc",
        "{\n  \"$schema\": \"./local.schema.json\"\n}\n",
    ));

    // ── claude-code: ~/.claude/settings.json ──────────────────────────────
    v.push(case("claude-code", "fresh"));
    v.push(case("claude-code", "rerun").twice());
    v.push(case("claude-code", "empty_key").key(""));
    v.push(case("claude-code", "empty_model").model(""));
    v.push(
        case("claude-code", "existing_settings_preserved").seed(
            ".claude/settings.json",
            "{\n  \"permissions\": { \"allow\": [\"Bash(git diff:*)\"] },\n  \"env\": { \"MY_VAR\": \"keep-me\", \"ANTHROPIC_BASE_URL\": \"https://api.anthropic.com\" },\n  \"model\": \"opus\"\n}\n",
        ),
    );
    v.push(
        case("claude-code", "env_not_object_replaced")
            .seed(".claude/settings.json", "{\n  \"env\": \"nope\"\n}\n"),
    );
    v.push(
        case("claude-code", "rerun_empty_model_keeps_old_model_keys")
            .model("")
            .after(BASE_URL, MODEL, KEY),
    );

    // ── pi: ~/.pi/agent/{models,settings}.json ────────────────────────────
    v.push(case("pi", "fresh"));
    v.push(case("pi", "rerun").twice());
    v.push(case("pi", "empty_key").key(""));
    v.push(
        case("pi", "existing_other_provider")
            .seed(
                ".pi/agent/models.json",
                "{\n  \"providers\": {\n    \"anthropic\": {\n      \"api\": \"anthropic-messages\",\n      \"apiKey\": \"sk-ant-user\",\n      \"models\": [{ \"id\": \"claude-sonnet-4\" }]\n    }\n  }\n}\n",
            )
            .seed(
                ".pi/agent/settings.json",
                "{\n  \"theme\": \"nord\",\n  \"defaultProvider\": \"anthropic\",\n  \"defaultModel\": \"claude-sonnet-4\"\n}\n",
            ),
    );
    v.push(
        case("pi", "providers_not_object_replaced")
            .seed(".pi/agent/models.json", "{\n  \"providers\": []\n}\n"),
    );

    // ── codex: ~/.codex/config.toml, two managed blocks ───────────────────
    v.push(case("codex", "fresh"));
    v.push(case("codex", "rerun").twice());
    v.push(case("codex", "empty_key").key(""));
    v.push(
        case("codex", "existing_toml_preserved").seed(
            ".codex/config.toml",
            "approval_policy = \"on-request\"\n\n[model_providers.openai]\nname = \"OpenAI\"\nbase_url = \"https://api.openai.com/v1\"\nenv_key = \"OPENAI_API_KEY\"\n",
        ),
    );
    v.push(
        case("codex", "existing_managed_block_replaced").seed(
            ".codex/config.toml",
            "# >>> Atomic Chat (managed) >>>\nmodel = \"stale\"\nmodel_provider = \"atomic\"\n# <<< Atomic Chat (managed) <<<\n\nsandbox_mode = \"workspace-write\"\n\n# >>> Atomic Chat (managed) >>>\n[model_providers.atomic]\nname = \"Atomic Chat\"\nbase_url = \"http://127.0.0.1:9999/v1\"\n# <<< Atomic Chat (managed) <<<\n",
        ),
    );
    v.push(case("codex", "whitespace_only_file").seed(".codex/config.toml", "\n\n   \n"));
    v.push(case("codex", "model_needing_toml_escape").model("weird\\path/\"quoted\""));
    v.push(case("codex", "keyed_then_keyless_rerun").key("").after(
        &default_url("codex"),
        MODEL,
        KEY,
    ));

    // ── opencode: ~/.config/opencode/opencode.json ────────────────────────
    v.push(case("opencode", "fresh"));
    v.push(case("opencode", "rerun").twice());
    v.push(case("opencode", "empty_key").key(""));
    v.push(
        case("opencode", "existing_other_provider").seed(
            ".config/opencode/opencode.json",
            "{\n  \"$schema\": \"https://opencode.ai/config.json\",\n  \"theme\": \"tokyonight\",\n  \"provider\": {\n    \"ollama\": {\n      \"npm\": \"@ai-sdk/openai-compatible\",\n      \"name\": \"Ollama\",\n      \"options\": { \"baseURL\": \"http://localhost:11434/v1\" },\n      \"models\": { \"llama3.2\": { \"name\": \"llama3.2\" } }\n    }\n  },\n  \"model\": \"ollama/llama3.2\"\n}\n",
        ),
    );
    v.push(case("opencode", "empty_file").seed(".config/opencode/opencode.json", "  \n"));
    v.push(case("opencode", "provider_not_object_replaced").seed(
        ".config/opencode/opencode.json",
        "{\n  \"provider\": 42\n}\n",
    ));

    // ── openclaude: ~/.openclaude.json + ~/.openclaude/.openclaude-profile.json
    v.push(case("openclaude", "fresh"));
    v.push(case("openclaude", "rerun").twice());
    // The key argument is discarded by the writer; this pair proves it.
    v.push(case("openclaude", "empty_key_same_output").key(""));
    v.push(
        case("openclaude", "existing_profiles_preserved").seed(
            ".openclaude.json",
            "{\n  \"providerProfiles\": [\n    { \"id\": \"provider_openai\", \"name\": \"OpenAI\", \"provider\": \"openai\", \"baseUrl\": \"https://api.openai.com/v1\", \"model\": \"gpt-5\" }\n  ],\n  \"activeProviderProfileId\": \"provider_openai\",\n  \"telemetry\": false\n}\n",
        ),
    );
    v.push(
        case("openclaude", "matching_profile_replaced_in_place").seed(
            ".openclaude.json",
            "{\n  \"providerProfiles\": [\n    { \"id\": \"legacy_atomic\", \"provider\": \"atomic-chat\", \"baseUrl\": \"http://127.0.0.1:9999/v1\", \"model\": \"stale\", \"extraKey\": \"dropped\" },\n    { \"id\": \"provider_openai\", \"provider\": \"openai\" }\n  ]\n}\n",
        ),
    );
    v.push(
        case("openclaude", "profiles_not_array_replaced")
            .seed(".openclaude.json", "{\n  \"providerProfiles\": {}\n}\n"),
    );

    // ── cline: spawns `cline auth`, writes nothing ────────────────────────
    v.push(case("cline", "auth_success").mode(Mode::ClineOk));
    v.push(
        case("cline", "auth_success_empty_key")
            .key("")
            .mode(Mode::ClineOk),
    );
    v.push(case("cline", "auth_command_fails").mode(Mode::ClineFail));
    v.push(case("cline", "binary_missing").mode(Mode::ClineMissing));

    // ── dsh: $DSH_HOME/settings.yaml + .env + one-shot backup ─────────────
    v.push(case("dsh", "fresh"));
    v.push(case("dsh", "rerun").twice());
    v.push(case("dsh", "empty_key_writes_no_env").key(""));
    // A keyed run leaves a secret in .env; a later keyless run must clear it.
    v.push(case("dsh", "keyed_then_keyless_clears_env").key("").after(
        &default_url("dsh"),
        MODEL,
        KEY,
    ));
    v.push(
        case("dsh", "existing_yaml_preserved").seed(
            ".dsh/settings.yaml",
            "# my harness config\ntheme: dark\nllm-pi-ai:\n  providers:\n    openrouter:\n      displayName: OpenRouter\n      api: openai-completions\n      baseURL: https://openrouter.ai/api/v1\n      models:\n        - id: anthropic/claude-sonnet-4\nplugins:\n  enabled: true\n",
        ),
    );
    v.push(
        case("dsh", "existing_atomic_route_replaced_wholesale").seed(
            ".dsh/settings.yaml",
            "llm-pi-ai:\n  providers:\n    atomic:\n      displayName: Atomic Chat\n      api: openai-completions\n      baseURL: http://127.0.0.1:9999/v1\n      apiKeyEnv: ATOMIC_API_KEY\n      staleKey: should-vanish\n      models:\n        - id: old-model\n",
        ),
    );
    v.push(
        case("dsh", "backup_written_once")
            .twice()
            .seed(".dsh/settings.yaml", "theme: dark\n"),
    );
    v.push(case("dsh", "existing_env_preserved").seed(".dsh/.env", "MY_TOKEN=keep-me\nOTHER=1\n"));
    v.push(
        case("dsh", "comment_only_yaml").seed(".dsh/settings.yaml", "# nothing but a comment\n"),
    );
    v.push(case("dsh", "empty_url_rejected").url(""));
    v.push(case("dsh", "empty_model_rejected").model(""));
    v.push(case("dsh", "key_with_whitespace_rejected").key("sk atomic"));
    v.push(case("dsh", "key_with_hash_rejected").key("sk#atomic"));

    // ── zed: ~/.config/zed/settings.json, parsed as JSON5 ─────────────────
    v.push(case("zed", "fresh"));
    v.push(case("zed", "rerun").twice());
    v.push(case("zed", "empty_model").model(""));
    // Zed never persists the key; this must match `fresh` byte for byte.
    v.push(case("zed", "empty_key_same_output").key(""));
    v.push(
        case("zed", "existing_settings_preserved").seed(
            ".config/zed/settings.json",
            "{\n  // Zed settings\n  \"theme\": \"One Dark\",\n  \"language_models\": {\n    \"ollama\": { \"api_url\": \"http://localhost:11434\" },\n    \"openai_compatible\": {\n      \"Groq\": { \"api_url\": \"https://api.groq.com/openai/v1\", \"available_models\": [] }\n    }\n  },\n  \"agent\": { \"version\": \"2\", \"default_model\": { \"provider\": \"ollama\", \"model\": \"llama3.2\" } }\n}\n",
        ),
    );
    v.push(case("zed", "language_models_not_object_replaced").seed(
        ".config/zed/settings.json",
        "{\n  \"language_models\": []\n}\n",
    ));

    // ── mimo: ~/.config/mimocode/mimocode.json (OpenCode fork) ────────────
    v.push(case("mimo", "fresh"));
    v.push(case("mimo", "rerun").twice());
    v.push(case("mimo", "empty_key").key(""));
    v.push(
        case("mimo", "existing_other_provider").seed(
            ".config/mimocode/mimocode.json",
            "{\n  \"$schema\": \"https://mimo.xiaomi.com/config.json\",\n  \"provider\": {\n    \"deepseek\": {\n      \"npm\": \"@ai-sdk/openai-compatible\",\n      \"name\": \"DeepSeek\",\n      \"options\": { \"baseURL\": \"https://api.deepseek.com\" },\n      \"models\": { \"deepseek-chat\": { \"name\": \"deepseek-chat\" } }\n    }\n  },\n  \"model\": \"deepseek/deepseek-chat\"\n}\n",
        ),
    );

    // ── droid: ~/.factory/settings.json, index-based selector ─────────────
    v.push(case("droid", "fresh"));
    v.push(case("droid", "rerun").twice());
    v.push(case("droid", "empty_key").key(""));
    v.push(
        case("droid", "appended_after_existing_models").seed(
            ".factory/settings.json",
            "{\n  \"customModels\": [\n    { \"model\": \"gpt-5\", \"displayName\": \"My OpenAI\", \"baseUrl\": \"https://api.openai.com/v1\", \"apiKey\": \"sk-user\", \"provider\": \"generic-chat-completion-api\" }\n  ],\n  \"model\": \"custom:My-OpenAI-0\",\n  \"autoUpdate\": false\n}\n",
        ),
    );
    v.push(
        case("droid", "existing_atomic_entry_replaced_at_its_index").seed(
            ".factory/settings.json",
            "{\n  \"customModels\": [\n    { \"model\": \"stale\", \"displayName\": \"Atomic Chat\", \"baseUrl\": \"http://127.0.0.1:9999/v1\", \"apiKey\": \"old\", \"provider\": \"generic-chat-completion-api\", \"maxOutputTokens\": 4096 },\n    { \"model\": \"gpt-5\", \"displayName\": \"My OpenAI\" }\n  ]\n}\n",
        ),
    );
    v.push(case("droid", "custom_models_not_array_replaced").seed(
        ".factory/settings.json",
        "{\n  \"customModels\": \"oops\"\n}\n",
    ));

    // ── copilot: shell rc, marked block ───────────────────────────────────
    v.push(case("copilot", "fresh_zsh"));
    v.push(case("copilot", "rerun_zsh").twice());
    v.push(case("copilot", "empty_key_omits_key_var").key(""));
    v.push(case("copilot", "existing_rc_preserved").seed(
        ".zshenv",
        "export EDITOR=nvim\nexport PATH=\"$HOME/bin:$PATH\"\n",
    ));
    v.push(case("copilot", "stray_prefixed_export_removed").seed(
        ".zshenv",
        "export EDITOR=nvim\nexport COPILOT_MODEL='leftover-from-an-old-format'\n",
    ));
    v.push(case("copilot", "fresh_bash").shell("/bin/bash"));
    v.push(case("copilot", "keyed_then_keyless_rerun").key("").after(
        &default_url("copilot"),
        MODEL,
        KEY,
    ));

    // ── openhands: shell rc ───────────────────────────────────────────────
    v.push(case("openhands", "fresh_zsh"));
    v.push(case("openhands", "rerun_zsh").twice());
    v.push(case("openhands", "empty_key_uses_placeholder").key(""));
    v.push(
        case("openhands", "existing_rc_preserved")
            .seed(".zshenv", "export EDITOR=nvim\nexport LANG=en_US.UTF-8\n"),
    );
    v.push(case("openhands", "fresh_bash").shell("/bin/bash"));

    // ── poolside: shell rc, base url normalisation ────────────────────────
    v.push(case("poolside", "fresh_zsh"));
    v.push(case("poolside", "rerun_zsh").twice());
    v.push(case("poolside", "empty_key_uses_placeholder").key(""));
    v.push(case("poolside", "url_without_v1").url("http://127.0.0.1:1337"));
    v.push(case("poolside", "url_with_trailing_slash").url("http://127.0.0.1:1337/v1/"));
    v.push(case("poolside", "url_with_padding").url("  http://127.0.0.1:1337/v1//  "));
    v.push(case("poolside", "existing_rc_preserved").seed(".zshenv", "export EDITOR=nvim\n"));

    // ── goose: shell rc, block strips non-prefixed managed vars ───────────
    v.push(case("goose", "fresh_zsh"));
    v.push(case("goose", "rerun_zsh").twice());
    v.push(case("goose", "empty_key_uses_placeholder").key(""));
    // The user's own OPENAI_* export lives outside the block and must survive,
    // even though the managed block writes OPENAI_* vars too.
    v.push(case("goose", "unrelated_openai_export_preserved").seed(
        ".zshenv",
        "export OPENAI_API_KEY='sk-user-owned'\nexport EDITOR=nvim\n",
    ));
    v.push(case("goose", "fresh_bash").shell("/bin/bash"));

    // ── muse: shell rc, key only ──────────────────────────────────────────
    v.push(case("muse", "fresh_zsh"));
    v.push(case("muse", "rerun_zsh").twice());
    v.push(case("muse", "empty_key_uses_placeholder").key(""));
    v.push(case("muse", "existing_rc_preserved").seed(
        ".zshenv",
        "export EDITOR=nvim\nexport META_UNRELATED='clobbered'\n",
    ));

    // ── atomic-agent: ~/.atomic-agent/config.json ─────────────────────────
    v.push(case("atomic-agent", "fresh"));
    v.push(case("atomic-agent", "rerun").twice());
    v.push(case("atomic-agent", "empty_key").key(""));
    v.push(case("atomic-agent", "empty_model_rejected").model(""));
    v.push(
        case("atomic-agent", "existing_providers_preserved").seed(
            ".atomic-agent/config.json",
            "{\n  \"version\": 3,\n  \"llm\": {\n    \"providers\": [\n      { \"id\": \"local-llama\", \"kind\": \"llama-server\", \"url\": \"http://127.0.0.1:8080\", \"baseUrl\": \"http://127.0.0.1:8080\" },\n      { \"id\": \"openai\", \"kind\": \"openai\", \"apiKey\": \"sk-user\" }\n    ],\n    \"activeTextProvider\": \"openai\",\n    \"activeEmbeddingProvider\": \"local-llama\"\n  },\n  \"ui\": { \"theme\": \"dark\" }\n}\n",
        ),
    );
    v.push(
        case("atomic-agent", "dangling_embedding_provider_repaired").seed(
            ".atomic-agent/config.json",
            "{\n  \"llm\": {\n    \"providers\": [ { \"id\": \"openai\", \"kind\": \"openai\" } ],\n    \"activeEmbeddingProvider\": \"gone-away\"\n  }\n}\n",
        ),
    );
    v.push(case("atomic-agent", "managed_mode_seeds_daemon_url").seed(
        ".atomic-agent/config.json",
        "{\n  \"localModels\": { \"mode\": \"managed\", \"managed\": { \"port\": 20001 } }\n}\n",
    ));
    v.push(case("atomic-agent", "managed_mode_default_port").seed(
        ".atomic-agent/config.json",
        "{\n  \"localModels\": { \"mode\": \"managed\" }\n}\n",
    ));
    v.push(
        case("atomic-agent", "embeddings_enabled_splits_base_url").seed(
            ".atomic-agent/config.json",
            "{\n  \"localModels\": { \"url\": \"http://127.0.0.1:8081\", \"embeddings\": { \"enabled\": true, \"port\": 19092 } }\n}\n",
        ),
    );
    v.push(
        case("atomic-agent", "embeddings_explicit_url").seed(
            ".atomic-agent/config.json",
            "{\n  \"localModels\": { \"embeddings\": { \"enabled\": true, \"url\": \"http://embed.local:9000\" } }\n}\n",
        ),
    );
    v.push(
        case("atomic-agent", "existing_timeout_on_our_entry_preserved").seed(
            ".atomic-agent/config.json",
            "{\n  \"llm\": {\n    \"providers\": [ { \"id\": \"atomic-chat\", \"kind\": \"openai-compatible\", \"requestTimeoutMs\": 900000 } ],\n    \"activeEmbeddingProvider\": \"atomic-chat\"\n  }\n}\n",
        ),
    );
    v.push(
        case("atomic-agent", "llm_not_object_replaced")
            .seed(".atomic-agent/config.json", "{\n  \"llm\": \"nope\"\n}\n"),
    );

    // ── hermes: ~/.hermes/config.yaml (+ .env when it exists) ─────────────
    v.push(case("hermes", "fresh_seeds_skeleton"));
    v.push(case("hermes", "rerun").twice());
    v.push(case("hermes", "empty_key_same_output").key(""));
    v.push(
        case("hermes", "existing_config_other_providers_preserved").seed(
            ".hermes/config.yaml",
            "model:\n  default: anthropic/claude-opus-4.6\n  provider: auto\n  base_url: https://openrouter.ai/api/v1\ncustom_providers:\n- name: telegram-bridge\n  base_url: http://localhost:9000\n  model: bridge\ntools:\n  web_search: true\n",
        ),
    );
    v.push(
        case("hermes", "existing_atomic_provider_replaced").seed(
            ".hermes/config.yaml",
            "model:\n  default: stale\n  provider: custom\n  base_url: http://127.0.0.1:9999/v1\ncustom_providers:\n- name: atomic-chat\n  base_url: http://127.0.0.1:9999/v1\n  model: stale\n  models:\n    stale:\n      context_length: 4096\n",
        ),
    );
    v.push(
        case("hermes", "existing_provider_timeout_preserved").seed(
            ".hermes/config.yaml",
            "model:\n  default: x\n  provider: auto\n  base_url: https://example.invalid\ncustom_providers: []\nproviders:\n  custom:\n    request_timeout_seconds: 42\n  openai:\n    request_timeout_seconds: 60\n",
        ),
    );
    v.push(case("hermes", "env_gets_no_proxy").seed(".hermes/.env", "HERMES_API_KEY=user-key"));
    v.push(
        case("hermes", "env_with_no_proxy_untouched")
            .seed(".hermes/.env", "NO_PROXY=example.com\n"),
    );
    v.push(case("hermes", "config_without_trailing_newline").seed(
        ".hermes/config.yaml",
        "model:\n  default: x\n  provider: auto\n  base_url: https://example.invalid",
    ));

    // ── openclaw: ~/.openclaw/openclaw.json, parsed as JSON5 ──────────────
    v.push(case("openclaw", "fresh"));
    v.push(case("openclaw", "rerun").twice());
    v.push(case("openclaw", "empty_key").key(""));
    v.push(
        case("openclaw", "existing_settings_preserved").seed(
            ".openclaw/openclaw.json",
            "{\n  // openclaw config\n  \"gateway\": { \"mode\": \"remote\", \"auth\": { \"mode\": \"token\", \"token\": \"t\" } },\n  \"models\": { \"mode\": \"replace\", \"providers\": { \"openai\": { \"baseUrl\": \"https://api.openai.com/v1\" } } },\n  \"agents\": { \"defaults\": { \"timeoutSeconds\": 30, \"model\": { \"primary\": \"openai/gpt-5\", \"fallback\": [\"openai/gpt-4\"] } } }\n}\n",
        ),
    );
    v.push(
        case("openclaw", "model_policy_widened").seed(
            ".openclaw/openclaw.json",
            "{\n  \"agents\": { \"defaults\": { \"modelPolicy\": { \"allow\": [\"openai/gpt-5\"] } } }\n}\n",
        ),
    );
    v.push(case("openclaw", "empty_model_policy_left_alone").seed(
        ".openclaw/openclaw.json",
        "{\n  \"agents\": { \"defaults\": { \"modelPolicy\": { \"allow\": [] } } }\n}\n",
    ));
    v.push(
        case("openclaw", "model_policy_wildcard_already_allows").seed(
            ".openclaw/openclaw.json",
            "{\n  \"agents\": { \"defaults\": { \"modelPolicy\": { \"allow\": [\"atomic/*\"] } } }\n}\n",
        ),
    );
    v.push(case("openclaw", "model_entry_string_normalised").seed(
        ".openclaw/openclaw.json",
        "{\n  \"agents\": { \"defaults\": { \"model\": \"openai/gpt-5\" } }\n}\n",
    ));

    v
}

// ── emitter ────────────────────────────────────────────────────────────────

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .canonicalize()
        .expect("repo root")
}

fn git_head(root: &Path) -> String {
    std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .current_dir(root)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

#[test]
#[ignore]
fn dump_fixtures() {
    let root = repo_root();
    let out = root.join("tests/fixtures/core-contracts/agent-config");
    std::fs::create_dir_all(&out).expect("create fixture dir");
    let commit = git_head(&root);
    let source = "src-tauri/src/core/cli/fixture_dump.rs";

    let sandbox =
        std::env::temp_dir().join(format!("atomic-agent-fixtures-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&sandbox);
    std::fs::create_dir_all(&sandbox).expect("create sandbox");

    // Anything the emitter cannot reproduce is written as a placeholder rather
    // than a machine-specific value.
    let placeholders = json!({
        "<home>": "the fake home directory the case ran against; substituted anywhere its absolute path appears in a file's contents",
        "<timestamp>": "a wall-clock RFC 3339 instant written by the agent writer (only `createdAt` in OpenClaude's profile file)",
        "<os-error>": "the platform-specific std::io::Error text after `Failed to spawn 'cline': `",
    });

    let mut names: Vec<String> = Vec::new();
    let mut existing: Vec<String> = std::fs::read_dir(&out)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.ends_with(".json"))
                .collect()
        })
        .unwrap_or_default();
    existing.sort();

    for c in cases() {
        // Cline needs an executable stub on PATH; on Windows the writer shells
        // through cmd.exe instead, so those cases are emitted from unix only.
        if c.mode != Mode::Files && !cfg!(unix) {
            continue;
        }
        let outcome = run_case(&c, &sandbox);
        let (url, model, key) = c.runs.last().expect("at least one run").clone();

        let mut expected = serde_json::Map::new();
        expected.insert("files".to_string(), json!(outcome.files));
        if let Some(spawn) = &outcome.spawn {
            expected.insert(
                "spawn".to_string(),
                json!({ "program": "cline", "args": spawn }),
            );
        }
        match &outcome.error {
            Some(e) => {
                expected.insert("ok".to_string(), json!(false));
                expected.insert("error".to_string(), json!(e));
            }
            None => {
                expected.insert("ok".to_string(), json!(true));
            }
        }

        let mut input = serde_json::Map::new();
        input.insert("agent".to_string(), json!(c.agent));
        input.insert("api_url".to_string(), json!(url));
        input.insert("model".to_string(), json!(model));
        input.insert("api_key".to_string(), json!(key));
        input.insert("seed_files".to_string(), json!(c.seed));
        input.insert("shell".to_string(), json!(c.shell));
        if c.runs.len() > 1 {
            input.insert(
                "prior_runs".to_string(),
                json!(c
                    .runs
                    .iter()
                    .take(c.runs.len() - 1)
                    .map(|(u, m, k)| json!({ "api_url": u, "model": m, "api_key": k }))
                    .collect::<Vec<_>>()),
            );
        }

        let doc = json!({
            "name": c.name,
            "source": { "file": source, "commit": commit },
            "comparator": "agent-config-files",
            "input": serde_json::Value::Object(input),
            "expected": serde_json::Value::Object(expected),
        });
        std::fs::write(
            out.join(format!("{}.json", c.name)),
            serde_json::to_string_pretty(&doc).expect("serialize case") + "\n",
        )
        .expect("write case");
        names.push(c.name.clone());
    }

    // A renamed or dropped scenario must not leave a stale case behind, or the
    // index and the directory disagree and `core-contracts.test.mjs` fails.
    let keep: std::collections::HashSet<String> =
        names.iter().map(|n| format!("{}.json", n)).collect();
    for stale in existing {
        if stale != "index.json" && !keep.contains(&stale) {
            let _ = std::fs::remove_file(out.join(stale));
        }
    }

    let index = json!({
        "source": { "file": source, "commit": commit },
        "comparator": "agent-config-files",
        "comparator_notes": {
            "agent-config-files": "Each case runs `cli::integrations::configure(agent, api_url, model, api_key)` \
    against a throwaway home directory. `input.seed_files` are written into that home (parent directories created) \
    BEFORE the call; `input.prior_runs`, when present, lists earlier `configure` invocations made in the same home, \
    in order, before the recorded one — that is how rerun/idempotence cases are expressed. `expected.files` is the \
    COMPLETE set of files present under the fake home afterwards: every path is relative to that home, uses forward \
    slashes, is sorted, and its value is the file's exact text — compare byte-exact, trailing newline included. A path \
    absent from `expected.files` must not exist after the port runs. `expected.ok` is false when `configure` returned \
    Err, and `expected.error` then carries the message verbatim.",
            "paths": "Relative to the fake home ($HOME on unix, %USERPROFILE% on Windows — `agent_home_dir()`). \
    The emitter also pins $DSH_HOME to `<home>/.dsh` (its default) so dsh never probes a login shell, and clears \
    $OPENCLAW_CONFIG_PATH, $ATOMIC_AGENT_STATE_DIR and $HERMES_HOME so every writer uses its default location.",
            "shell": "`input.shell` is $SHELL during the run. The four env-var agents (copilot, goose, openhands, \
    muse, poolside) pick their rc file from it: a value ending in `/bash` selects ~/.bash_profile on macOS and \
    ~/.bashrc on Linux, anything else selects ~/.zshenv. These fixtures were emitted on a host where \
    cfg!(target_os) = macos, so the bash cases show ~/.bash_profile; on Linux the same writer targets ~/.bashrc.",
            "cline": "Cline writes no config file at all — it runs `cline auth …` as a subprocess. Those cases put a \
    recording stub named `cline` on PATH, so `expected.spawn` is the exact argv the writer passed, `expected.files` is \
    empty, and the failure/missing cases show the error text. A port must reproduce the argv, not a file.",
            "placeholders": placeholders,
        },
        "cases": names,
    });
    std::fs::write(
        out.join("index.json"),
        serde_json::to_string_pretty(&index).expect("serialize index") + "\n",
    )
    .expect("write index");

    let _ = std::fs::remove_dir_all(&sandbox);
    eprintln!(
        "wrote {} agent-config fixtures to {}",
        names.len(),
        out.display()
    );
}
