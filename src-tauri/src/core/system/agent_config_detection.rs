//! Read-only detection of the Launch-page agents whose own configuration on
//! disk already points at Atomic Chat.
//!
//! Each check looks for the marker the matching `configure_*` command in
//! [`super::commands`] writes (our provider entry, our managed block, our env
//! vars), at the location that command writes to — the paths are resolved by
//! the very same helpers. Nothing here writes, creates directories or fails: a
//! missing or unparsable file simply means "not configured".
//!
//! Not covered: `cline` (configured by running `cline auth`, whose on-disk state
//! is an undocumented legacy format), and the editors set up by hand (VS Code,
//! JetBrains, Xcode).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::commands::{
    agent_home_dir, detect_shell_env_file, dsh_home_dir, entry_is_ours,
    openclaude_global_config_path, openclaw_config_path, resolve_atomic_agent_state_dir,
    resolve_hermes_dir, split_custom_providers, zcode_config_dir, ATOMIC_AGENT_PROVIDER_ID,
    DSH_ROUTE_ID, DSH_SECTION, OPENCLAUDE_ATOMIC_PROFILE_ID, OPENCLAW_PROVIDER_ID,
    ZCODE_PROVIDER_ID, ZED_PROVIDER_ID,
};

/// Shell-rc block markers written by `write_marked_env_to_shell` (the `MARKER`
/// constant inside each `configure_*`), plus the legacy Claude Code block
/// `write_env_to_shell` writes. Keep in sync with `commands.rs`.
const COPILOT_SHELL_MARKER: &str = "# Atomic Chat - Copilot CLI Config";
const GOOSE_SHELL_MARKER: &str = "# Atomic Chat - Goose Config";
const OPENHANDS_SHELL_MARKER: &str = "# Atomic Chat - OpenHands Config";
const POOLSIDE_SHELL_MARKER: &str = "# Atomic Chat - Poolside Config";
const MUSE_SHELL_MARKER: &str = "# Atomic Chat - Muse Code Config";
const STACK_AGENT_SHELL_MARKER: &str = "# Atomic Chat - stack-agent Config";
const LEGACY_CLAUDE_CODE_SHELL_MARKER: &str = "# Jan Local API Server - Claude Code Config";

/// `customModels[].displayName` `configure_droid` upserts by.
const DROID_DISPLAY_NAME: &str = "Atomic Chat";
/// Provider key `configure_opencode` / `configure_mimo` / `configure_kilo` /
/// `configure_pi` write under `provider` (`providers` for Pi).
const ATOMIC_PROVIDER_KEY: &str = "atomic";
/// `provider` of the OpenClaude profile (and `profile` of its startup file).
const OPENCLAUDE_PROVIDER: &str = "atomic-chat";
/// Placeholder `muse_env_vars` stores in `META_API_KEY` when the local server
/// has no key.
const MUSE_KEY_PLACEHOLDER: &str = "atomic";

/// Every location detection reads.
pub(crate) struct AgentConfigPaths {
    pub home: PathBuf,
    /// The shell rc file `detect_shell_env_file` picks; `None` on Windows,
    /// where the env-var agents are configured through `setx`.
    pub shell_env_file: Option<PathBuf>,
    pub hermes_dir: Option<PathBuf>,
    pub zcode_dir: PathBuf,
    pub atomic_agent_dir: Option<PathBuf>,
    pub dsh_home: Option<PathBuf>,
    pub openclaw_config: PathBuf,
    pub openclaude_config: PathBuf,
}

impl AgentConfigPaths {
    /// Default locations under `home`, with no environment overrides.
    #[cfg(test)]
    pub(crate) fn under_home(home: &Path, shell_env_file: Option<&Path>) -> Self {
        Self {
            home: home.to_path_buf(),
            shell_env_file: shell_env_file.map(Path::to_path_buf),
            hermes_dir: Some(home.join(".hermes")),
            zcode_dir: zcode_config_dir(home, None),
            atomic_agent_dir: Some(home.join(".atomic-agent")),
            dsh_home: Some(home.join(".dsh")),
            openclaw_config: home.join(".openclaw").join("openclaw.json"),
            openclaude_config: home.join(".openclaude.json"),
        }
    }

    /// The locations the `configure_*` commands write to on this machine.
    fn resolve() -> Option<Self> {
        let home_str = agent_home_dir().ok()?;
        let home = PathBuf::from(&home_str);
        let shell_env_file = if cfg!(windows) {
            None
        } else {
            let (_shell, file) = detect_shell_env_file(&home_str, cfg!(target_os = "macos"));
            Some(PathBuf::from(file))
        };
        let zcode_env = std::env::var("ZCODE_DATA_BASE_DIR").ok();
        Some(Self {
            shell_env_file,
            hermes_dir: resolve_hermes_dir().ok(),
            zcode_dir: zcode_config_dir(&home, zcode_env.as_deref()),
            atomic_agent_dir: resolve_atomic_agent_state_dir().ok(),
            dsh_home: dsh_home_dir().ok(),
            openclaw_config: openclaw_config_path(&home_str),
            openclaude_config: openclaude_global_config_path(&home_str),
            home,
        })
    }
}

/// Ids of the agents whose config already points at Atomic Chat, in the
/// Launch page's catalog order.
///
/// `user_env` reads a persistent User-scope env var (Windows `HKCU\Environment`,
/// where `setx` writes); off Windows it returns `None`.
pub(crate) fn detect_configured_agents_in(
    paths: &AgentConfigPaths,
    user_env: &dyn Fn(&str) -> Option<String>,
) -> Vec<String> {
    let home = paths.home.as_path();
    let rc = paths
        .shell_env_file
        .as_deref()
        .and_then(read_text)
        .unwrap_or_default();
    let block = |marker: &str| shell_block_vars(&rc, marker);
    let user_env_is_local = |name: &str| user_env(name).is_some_and(|v| is_local_url(&v));

    let checks: [(&str, bool); 19] = [
        (
            "kilo",
            json_file(&home.join(".config").join("kilo").join("kilo.jsonc"))
                .is_some_and(|v| has_object(&v, &["provider", ATOMIC_PROVIDER_KEY])),
        ),
        (
            "claude-code",
            claude_code_settings_local(home)
                || block(LEGACY_CLAUDE_CODE_SHELL_MARKER)
                    .is_some_and(|vars| var_is_local(&vars, "ANTHROPIC_BASE_URL"))
                || user_env_is_local("ANTHROPIC_BASE_URL"),
        ),
        (
            "pi",
            json_file(&home.join(".pi").join("agent").join("models.json"))
                .is_some_and(|v| has_object(&v, &["providers", ATOMIC_PROVIDER_KEY])),
        ),
        ("codex", codex_configured(home)),
        (
            "opencode",
            json_file(&home.join(".config").join("opencode").join("opencode.json"))
                .is_some_and(|v| has_object(&v, &["provider", ATOMIC_PROVIDER_KEY])),
        ),
        ("openclaude", openclaude_configured(paths)),
        ("dsh", paths.dsh_home.as_deref().is_some_and(dsh_configured)),
        (
            "zed",
            json_file(&home.join(".config").join("zed").join("settings.json")).is_some_and(|v| {
                has_object(
                    &v,
                    &["language_models", "openai_compatible", ZED_PROVIDER_ID],
                )
            }),
        ),
        ("zcode", zcode_configured(&paths.zcode_dir)),
        (
            "mimo",
            json_file(&home.join(".config").join("mimocode").join("mimocode.json"))
                .is_some_and(|v| has_object(&v, &["provider", ATOMIC_PROVIDER_KEY])),
        ),
        (
            "droid",
            json_file(&home.join(".factory").join("settings.json")).is_some_and(|v| {
                array_has(&v, &["customModels"], |m| {
                    str_at(m, "displayName") == Some(DROID_DISPLAY_NAME)
                })
            }),
        ),
        (
            "copilot",
            block(COPILOT_SHELL_MARKER)
                .is_some_and(|vars| var_is_local(&vars, "COPILOT_PROVIDER_BASE_URL"))
                || user_env_is_local("COPILOT_PROVIDER_BASE_URL"),
        ),
        (
            "openhands",
            block(OPENHANDS_SHELL_MARKER).is_some_and(|vars| var_is_local(&vars, "LLM_BASE_URL"))
                || user_env_is_local("LLM_BASE_URL"),
        ),
        (
            "poolside",
            block(POOLSIDE_SHELL_MARKER)
                .is_some_and(|vars| var_is_local(&vars, "POOLSIDE_STANDALONE_BASE_URL"))
                || user_env_is_local("POOLSIDE_STANDALONE_BASE_URL"),
        ),
        (
            "stack-agent",
            block(STACK_AGENT_SHELL_MARKER)
                .is_some_and(|vars| var_is_local(&vars, "CHIP_ENDPOINT"))
                || user_env_is_local("CHIP_ENDPOINT"),
        ),
        (
            "goose",
            block(GOOSE_SHELL_MARKER).is_some_and(|vars| var_is_local(&vars, "OPENAI_HOST"))
                || (user_env("GOOSE_PROVIDER").as_deref().map(str::trim) == Some("openai")
                    && user_env_is_local("OPENAI_HOST")),
        ),
        (
            "muse",
            // Muse takes the endpoint as a launch flag, so the only persisted
            // piece is the key. On Windows only our keyless placeholder is
            // recognisable as ours.
            block(MUSE_SHELL_MARKER).is_some()
                || user_env("META_API_KEY").as_deref().map(str::trim) == Some(MUSE_KEY_PLACEHOLDER),
        ),
        (
            "atomic-agent",
            paths.atomic_agent_dir.as_deref().is_some_and(|dir| {
                json_file(&dir.join("config.json")).is_some_and(|v| {
                    array_has(&v, &["llm", "providers"], |p| {
                        str_at(p, "id") == Some(ATOMIC_AGENT_PROVIDER_ID)
                    })
                })
            }),
        ),
        (
            "hermes",
            paths
                .hermes_dir
                .as_deref()
                .and_then(|dir| read_text(&dir.join("config.yaml")))
                .is_some_and(|text| {
                    let (_, entries, _) = split_custom_providers(&text);
                    entries.iter().any(|e| entry_is_ours(e))
                }),
        ),
        (
            "openclaw",
            json_file(&paths.openclaw_config)
                .is_some_and(|v| has_object(&v, &["models", "providers", OPENCLAW_PROVIDER_ID])),
        ),
    ];

    checks
        .into_iter()
        .filter(|(_, configured)| *configured)
        .map(|(id, _)| id.to_string())
        .collect()
}

/// Ids of the integration agents whose own config on disk already points at
/// Atomic Chat (written by our `configure_*` commands, possibly by an older
/// release). Read-only; never fails — anything unreadable counts as not
/// configured.
#[tauri::command]
pub async fn detect_configured_agents() -> Vec<String> {
    // Path resolution may spawn a login shell (dsh) or PowerShell (Hermes,
    // Atomic Agent on Windows), so keep it off the async runtime.
    let found = tokio::task::spawn_blocking(|| match AgentConfigPaths::resolve() {
        Some(paths) => detect_configured_agents_in(&paths, &read_user_env),
        None => Vec::new(),
    })
    .await
    .unwrap_or_default();
    log::debug!("Agents already configured for Atomic Chat: {:?}", found);
    found
}

/// A persistent User-scope env var from `HKCU\Environment`, where `setx` writes.
#[cfg(windows)]
fn read_user_env(name: &str) -> Option<String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Environment")
        .ok()?
        .get_value::<String, _>(name)
        .ok()
        .filter(|v| !v.trim().is_empty())
}

#[cfg(not(windows))]
fn read_user_env(_name: &str) -> Option<String> {
    None
}

fn read_text(path: &Path) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .filter(|t| !t.trim().is_empty())
}

/// Parse a JSON / JSONC / JSON5 file. Strict JSON first: it is far faster on the
/// large files some agents keep (e.g. `~/.openclaude.json`).
fn json_file(path: &Path) -> Option<serde_json::Value> {
    let text = read_text(path)?;
    serde_json::from_str(&text)
        .ok()
        .or_else(|| json5::from_str(&text).ok())
}

fn value_at<'a>(root: &'a serde_json::Value, keys: &[&str]) -> Option<&'a serde_json::Value> {
    keys.iter().try_fold(root, |v, k| v.get(*k))
}

fn has_object(root: &serde_json::Value, keys: &[&str]) -> bool {
    value_at(root, keys).is_some_and(serde_json::Value::is_object)
}

fn array_has(
    root: &serde_json::Value,
    keys: &[&str],
    pred: impl Fn(&serde_json::Value) -> bool,
) -> bool {
    value_at(root, keys)
        .and_then(serde_json::Value::as_array)
        .is_some_and(|arr| arr.iter().any(pred))
}

fn str_at<'a>(v: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(serde_json::Value::as_str)
}

/// `~/.claude/settings.json` `env.ANTHROPIC_BASE_URL` on a local / LAN host —
/// a corporate gateway URL there is the user's own setup, not ours.
fn claude_code_settings_local(home: &Path) -> bool {
    json_file(&home.join(".claude").join("settings.json")).is_some_and(|v| {
        value_at(&v, &["env", "ANTHROPIC_BASE_URL"])
            .and_then(serde_json::Value::as_str)
            .is_some_and(is_local_url)
    })
}

/// Our `[model_providers.atomic]` table in `~/.codex/config.toml` (current and
/// older releases both write it inside a managed block).
fn codex_configured(home: &Path) -> bool {
    read_text(&home.join(".codex").join("config.toml")).is_some_and(|text| {
        text.lines()
            .any(|l| l.trim() == format!("[model_providers.{}]", ATOMIC_PROVIDER_KEY))
    })
}

fn openclaude_configured(paths: &AgentConfigPaths) -> bool {
    let profile_listed = json_file(&paths.openclaude_config).is_some_and(|v| {
        array_has(&v, &["providerProfiles"], |p| {
            str_at(p, "id") == Some(OPENCLAUDE_ATOMIC_PROFILE_ID)
                || str_at(p, "provider") == Some(OPENCLAUDE_PROVIDER)
        })
    });
    profile_listed
        || json_file(
            &paths
                .home
                .join(".openclaude")
                .join(".openclaude-profile.json"),
        )
        .is_some_and(|v| str_at(&v, "profile") == Some(OPENCLAUDE_PROVIDER))
}

/// `llm-pi-ai.providers.atomic` in `$DSH_HOME/settings.yaml`.
fn dsh_configured(dsh_home: &Path) -> bool {
    read_text(&dsh_home.join("settings.yaml"))
        .and_then(|text| serde_yaml::from_str::<serde_yaml::Value>(&text).ok())
        .is_some_and(|root| {
            root.get(DSH_SECTION)
                .and_then(|s| s.get("providers"))
                .and_then(|p| p.get(DSH_ROUTE_ID))
                .is_some_and(serde_yaml::Value::is_mapping)
        })
}

/// Our provider rule in ZCode's `provider_config.json`.
fn zcode_configured(zcode_dir: &Path) -> bool {
    json_file(&zcode_dir.join("provider_config.json")).is_some_and(|v| {
        array_has(
            &v,
            &["config", "providerConfigRules", "providerRules"],
            |r| str_at(r, "providerId") == Some(ZCODE_PROVIDER_ID),
        )
    })
}

/// The `export K='V'` lines inside a `marker` ... `marker` block of a shell rc
/// file, or `None` when the file has no such block.
fn shell_block_vars(content: &str, marker: &str) -> Option<HashMap<String, String>> {
    let mut found = false;
    let mut in_block = false;
    let mut vars = HashMap::new();
    for line in content.lines() {
        if line.starts_with(marker) {
            found = true;
            in_block = !in_block;
            continue;
        }
        if !in_block {
            continue;
        }
        if let Some((key, value)) = line
            .trim()
            .strip_prefix("export ")
            .and_then(|rest| rest.split_once('='))
        {
            vars.insert(key.trim().to_string(), unquote(value.trim()).to_string());
        }
    }
    found.then_some(vars)
}

fn unquote(v: &str) -> &str {
    for q in ['\'', '"'] {
        if v.len() >= 2 && v.starts_with(q) && v.ends_with(q) {
            return &v[1..v.len() - 1];
        }
    }
    v
}

fn var_is_local(vars: &HashMap<String, String>, name: &str) -> bool {
    vars.get(name).is_some_and(|v| is_local_url(v))
}

/// Whether `raw` points at this machine or the local network: `localhost`,
/// loopback, `0.0.0.0`, private / link-local IPv4, or loopback / unique-local /
/// link-local IPv6. A scheme-less `host:port` is accepted too.
pub(crate) fn is_local_url(raw: &str) -> bool {
    let raw = raw.trim();
    if raw.is_empty() {
        return false;
    }
    let parsed = url::Url::parse(raw)
        .ok()
        .filter(url::Url::has_host)
        .or_else(|| url::Url::parse(&format!("http://{}", raw)).ok());
    let Some(parsed) = parsed else {
        return false;
    };
    match parsed.host() {
        Some(url::Host::Domain(d)) => {
            let d = d.trim_end_matches('.').to_ascii_lowercase();
            d == "localhost" || d.ends_with(".localhost")
        }
        Some(url::Host::Ipv4(ip)) => is_local_ipv4(ip),
        Some(url::Host::Ipv6(ip)) => {
            let first = ip.segments()[0];
            ip.is_loopback()
                || ip.is_unspecified()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
                || ip.to_ipv4_mapped().is_some_and(is_local_ipv4)
        }
        None => false,
    }
}

fn is_local_ipv4(ip: std::net::Ipv4Addr) -> bool {
    ip.is_loopback() || ip.is_private() || ip.is_unspecified() || ip.is_link_local()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn no_user_env(_: &str) -> Option<String> {
        None
    }

    fn detect(home: &Path, rc: Option<&Path>) -> Vec<String> {
        detect_configured_agents_in(&AgentConfigPaths::under_home(home, rc), &no_user_env)
    }

    #[test]
    fn nothing_configured_is_empty_and_creates_nothing() {
        let home = tempfile::tempdir().unwrap();
        let rc = home.path().join(".zshenv");
        assert!(detect(home.path(), Some(&rc)).is_empty());
        assert!(std::fs::read_dir(home.path()).unwrap().next().is_none());
    }

    #[test]
    fn other_providers_only_are_not_ours() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        write(
            &h.join(".config/opencode/opencode.json"),
            r#"{"provider":{"ollama":{"options":{"baseURL":"http://localhost:11434/v1"}}}}"#,
        );
        write(
            &h.join(".codex/config.toml"),
            "model_provider = \"ollama\"\n[model_providers.ollama]\nbase_url = \"http://localhost:11434/v1\"\n",
        );
        write(
            &h.join(".config/zed/settings.json"),
            r#"{"language_models":{"openai_compatible":{"Other":{"api_url":"http://x"}}}}"#,
        );
        assert!(detect(h, None).is_empty());
    }

    #[test]
    fn unparsable_files_are_not_configured() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        write(&h.join(".config/opencode/opencode.json"), "{ not json");
        write(&h.join(".claude/settings.json"), "[[[");
        write(&h.join(".dsh/settings.yaml"), "llm-pi-ai: [unclosed");
        assert!(detect(h, None).is_empty());
    }

    #[test]
    fn detects_opencode_provider_entry() {
        let home = tempfile::tempdir().unwrap();
        write(
            &home.path().join(".config/opencode/opencode.json"),
            r#"{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "atomic": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Atomic Chat",
      "options": { "baseURL": "http://127.0.0.1:1337/v1", "apiKey": "atomic" },
      "models": { "qwen3": { "name": "qwen3" } }
    }
  },
  "model": "atomic/qwen3"
}
"#,
        );
        assert_eq!(detect(home.path(), None), vec!["opencode"]);
    }

    #[test]
    fn detects_codex_managed_provider_table() {
        let home = tempfile::tempdir().unwrap();
        write(
            &home.path().join(".codex/config.toml"),
            "# >>> Atomic Chat (managed) >>>\nmodel = \"qwen3\"\nmodel_provider = \"atomic\"\n\
             # <<< Atomic Chat (managed) <<<\n\n[mcp_servers.x]\ncommand = \"x\"\n\
             # >>> Atomic Chat (managed) >>>\n[model_providers.atomic]\nname = \"Atomic Chat\"\n\
             base_url = \"http://127.0.0.1:1337/v1\"\n# <<< Atomic Chat (managed) <<<\n",
        );
        assert_eq!(detect(home.path(), None), vec!["codex"]);
    }

    #[test]
    fn detects_zed_provider_in_jsonc() {
        let home = tempfile::tempdir().unwrap();
        write(
            &home.path().join(".config/zed/settings.json"),
            r#"// Zed settings
{
  "theme": "One Dark", // trailing comment
  "language_models": {
    "openai_compatible": {
      "Atomic Chat": { "api_url": "http://127.0.0.1:1337/v1", "available_models": [], },
    },
  },
}
"#,
        );
        assert_eq!(detect(home.path(), None), vec!["zed"]);
    }

    #[test]
    fn claude_code_counts_only_a_local_base_url() {
        let home = tempfile::tempdir().unwrap();
        let settings = home.path().join(".claude/settings.json");

        write(
            &settings,
            r#"{"env":{"ANTHROPIC_BASE_URL":"http://localhost:1337","ANTHROPIC_AUTH_TOKEN":"atomic"}}"#,
        );
        assert_eq!(detect(home.path(), None), vec!["claude-code"]);

        write(
            &settings,
            r#"{"env":{"ANTHROPIC_BASE_URL":"http://192.168.1.20:1337"}}"#,
        );
        assert_eq!(detect(home.path(), None), vec!["claude-code"]);

        write(
            &settings,
            r#"{"env":{"ANTHROPIC_BASE_URL":"https://llm-gateway.corp.example.com"}}"#,
        );
        assert!(detect(home.path(), None).is_empty());

        write(&settings, r#"{"model":"opus"}"#);
        assert!(detect(home.path(), None).is_empty());
    }

    #[test]
    fn detects_shell_rc_marker_blocks() {
        let home = tempfile::tempdir().unwrap();
        let rc = home.path().join(".zshenv");
        write(
            &rc,
            "export PATH=\"$HOME/bin:$PATH\"\n\
             # Atomic Chat - Copilot CLI Config\n\
             export COPILOT_PROVIDER_BASE_URL='http://127.0.0.1:1337/v1'\n\
             export COPILOT_PROVIDER_TYPE='openai'\n\
             export COPILOT_MODEL='qwen3'\n\
             # Atomic Chat - Copilot CLI Config\n\
             # Atomic Chat - Goose Config\n\
             export GOOSE_PROVIDER='openai'\n\
             export OPENAI_HOST='https://api.openai.com'\n\
             # Atomic Chat - Goose Config\n\
             # Atomic Chat - Muse Code Config\n\
             export META_API_KEY='atomic'\n\
             # Atomic Chat - Muse Code Config\n\
             # Jan Local API Server - Claude Code Config\n\
             export ANTHROPIC_BASE_URL='http://localhost:1337'\n\
             export ANTHROPIC_AUTH_TOKEN='jan'\n\
             # Jan Local API Server - Claude Code Config\n",
        );
        // Goose's block points somewhere remote, so it is not ours.
        assert_eq!(
            detect(home.path(), Some(&rc)),
            vec!["claude-code", "copilot", "muse"]
        );
        // The same file is ignored when it is not the rc file we write to.
        assert!(detect(home.path(), None).is_empty());
    }

    #[test]
    fn detects_windows_user_env_vars() {
        let home = tempfile::tempdir().unwrap();
        let env: HashMap<&str, &str> = HashMap::from([
            ("POOLSIDE_STANDALONE_BASE_URL", "http://127.0.0.1:1337"),
            ("LLM_BASE_URL", "https://api.example.com/v1"),
            ("GOOSE_PROVIDER", "openai"),
            ("OPENAI_HOST", "http://localhost:1337"),
            ("META_API_KEY", "sk-real-meta-key"),
            ("CHIP_ENDPOINT", "http://127.0.0.1:1337/v1/chat/completions"),
        ]);
        let lookup = |name: &str| env.get(name).map(|v| v.to_string());
        let found =
            detect_configured_agents_in(&AgentConfigPaths::under_home(home.path(), None), &lookup);
        assert_eq!(found, vec!["poolside", "stack-agent", "goose"]);
    }

    #[test]
    fn detects_the_remaining_file_based_agents() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        write(
            &h.join(".config/kilo/kilo.jsonc"),
            "{\n  // KiloCode\n  provider: { atomic: { name: 'Atomic Chat' } },\n}\n",
        );
        write(
            &h.join(".pi/agent/models.json"),
            r#"{"providers":{"atomic":{"baseUrl":"http://127.0.0.1:1337/v1"}}}"#,
        );
        write(
            &h.join(".openclaude.json"),
            r#"{"providerProfiles":[{"id":"provider_atomic_chat","provider":"atomic-chat"}]}"#,
        );
        write(
            &h.join(".dsh/settings.yaml"),
            "other-plugin:\n  x: 1\nllm-pi-ai:\n  providers:\n    atomic:\n      displayName: Atomic Chat\n      baseURL: http://127.0.0.1:1337/v1\n",
        );
        write(
            &h.join(".zcode/v2/provider_config.json"),
            r#"{"schemaVersion":1,"config":{"providerConfigRules":{"providerRules":[{"providerId":"atomic-chat"}]}}}"#,
        );
        write(
            &h.join(".config/mimocode/mimocode.json"),
            r#"{"provider":{"atomic":{}}}"#,
        );
        write(
            &h.join(".factory/settings.json"),
            r#"{"customModels":[{"displayName":"Atomic Chat","baseUrl":"http://127.0.0.1:1337/v1"}]}"#,
        );
        write(
            &h.join(".atomic-agent/config.json"),
            r#"{"llm":{"providers":[{"id":"local-llama"},{"id":"atomic-chat"}]}}"#,
        );
        write(
            &h.join(".hermes/config.yaml"),
            "model:\n  default: qwen3\n  provider: custom\n  base_url: http://127.0.0.1:1337/v1\n\
             custom_providers:\n- name: atomic-chat\n  base_url: http://127.0.0.1:1337/v1\n  model: qwen3\n",
        );
        write(
            &h.join(".openclaw/openclaw.json"),
            "{ models: { providers: { atomic: { baseUrl: 'http://127.0.0.1:1337/v1' } } } }",
        );
        assert_eq!(
            detect(h, None),
            vec![
                "kilo",
                "pi",
                "openclaude",
                "dsh",
                "zcode",
                "mimo",
                "droid",
                "atomic-agent",
                "hermes",
                "openclaw"
            ]
        );
    }

    #[test]
    fn openclaude_startup_profile_alone_counts() {
        let home = tempfile::tempdir().unwrap();
        write(
            &home.path().join(".openclaude/.openclaude-profile.json"),
            r#"{"profile":"atomic-chat","env":{"OPENAI_BASE_URL":"http://127.0.0.1:1337/v1"}}"#,
        );
        assert_eq!(detect(home.path(), None), vec!["openclaude"]);
    }

    #[test]
    fn local_url_classification() {
        for url in [
            "http://localhost:1337/v1",
            "http://127.0.0.1:1337",
            "http://0.0.0.0:1337",
            "http://10.0.0.5:1337",
            "http://172.16.3.4:1337",
            "http://192.168.1.20:1337/v1",
            "http://169.254.10.1",
            "http://[::1]:1337",
            "http://[fd00::1]:1337",
            "http://api.localhost:1337",
            "localhost:1337",
            "127.0.0.1:1337",
        ] {
            assert!(is_local_url(url), "{url} should be local");
        }
        for url in [
            "",
            "https://api.anthropic.com",
            "https://llm-gateway.corp.example.com",
            "http://8.8.8.8",
            "http://172.32.0.1",
            "http://[2001:db8::1]",
            "not a url",
        ] {
            assert!(!is_local_url(url), "{url} should not be local");
        }
    }
}
