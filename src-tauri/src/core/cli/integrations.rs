//! Catalog of coding agents the CLI can wire to a local model.
//!
//! This mirrors `web-app/src/constants/integrations.ts` so `atomic-chat-cli
//! launch` and the desktop Launch page configure agents identically. The three
//! GUI editors in that list (`vscode`, `jetbrains`, `xcode`) are omitted: they
//! keep their provider in secret/IDE storage with no writable config file, so
//! there is nothing a CLI could write for them.
//!
//! The `configure_*` functions this dispatches to live in
//! `core::system::commands` and are the exact same ones the Launch page invokes.
//! A drift test below asserts the two id sets stay in sync.

use crate::core::system::commands as agents;

/// How the agent is started once its config has been written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunMode {
    /// A terminal program: run it in the foreground and keep the model server
    /// alive for exactly as long as it runs.
    Terminal,
    /// A GUI app: open it and keep the model server up until Ctrl+C, since the
    /// launcher process returns immediately.
    Gui,
}

#[derive(Debug, Clone, Copy)]
pub struct Agent {
    /// Stable id, identical to the one in `integrations.ts`.
    pub id: &'static str,
    /// Display name (product names are not localized).
    pub name: &'static str,
    /// Binary probed via `which` / `where`, and the program we execute.
    pub detect_bin: &'static str,
    /// Extra names accepted on the command line for convenience.
    pub aliases: &'static [&'static str],
    /// Whether a model id must be resolved before the agent can be configured.
    pub requires_model: bool,
    /// When true the endpoint is passed WITH the API prefix (`/v1`). Claude Code
    /// and Goose append their own path and want the bare host:port.
    pub endpoint_with_prefix: bool,
    pub docs_url: &'static str,
    /// Argv appended after `detect_bin` so the user lands in a usable session
    /// rather than a help screen.
    pub run_args: &'static [&'static str],
    pub run_mode: RunMode,
}

/// Every agent the CLI can configure, in the same order as `integrations.ts`.
pub const AGENTS: &[Agent] = &[
    Agent {
        id: "kilo",
        name: "Kilo Code",
        detect_bin: "kilo",
        aliases: &[],
        requires_model: true,
        endpoint_with_prefix: true,
        docs_url: "https://kilo.ai/docs",
        run_args: &[],
        run_mode: RunMode::Terminal,
    },
    Agent {
        id: "claude-code",
        name: "Claude Code",
        detect_bin: "claude",
        aliases: &["claude", "claudecode"],
        requires_model: false,
        // Claude Code appends its own `/v1`.
        endpoint_with_prefix: false,
        docs_url: "https://docs.anthropic.com/en/docs/claude-code",
        run_args: &[],
        run_mode: RunMode::Terminal,
    },
    Agent {
        id: "pi",
        name: "pi",
        detect_bin: "pi",
        aliases: &[],
        requires_model: true,
        endpoint_with_prefix: true,
        docs_url: "https://github.com/earendil-works/pi",
        run_args: &[],
        run_mode: RunMode::Terminal,
    },
    Agent {
        id: "codex",
        name: "Codex CLI",
        detect_bin: "codex",
        aliases: &[],
        requires_model: true,
        endpoint_with_prefix: true,
        docs_url: "https://github.com/openai/codex",
        run_args: &[],
        run_mode: RunMode::Terminal,
    },
    Agent {
        id: "opencode",
        name: "OpenCode",
        detect_bin: "opencode",
        aliases: &[],
        requires_model: true,
        endpoint_with_prefix: true,
        docs_url: "https://opencode.ai",
        run_args: &[],
        run_mode: RunMode::Terminal,
    },
    Agent {
        id: "openclaude",
        name: "OpenClaude",
        detect_bin: "openclaude",
        aliases: &[],
        requires_model: true,
        endpoint_with_prefix: true,
        docs_url: "https://github.com/Gitlawb/openclaude",
        run_args: &[],
        run_mode: RunMode::Terminal,
    },
    Agent {
        id: "cline",
        name: "Cline CLI",
        detect_bin: "cline",
        aliases: &[],
        requires_model: true,
        endpoint_with_prefix: true,
        docs_url: "https://docs.cline.bot/cline-cli/getting-started",
        run_args: &[],
        run_mode: RunMode::Terminal,
    },
    Agent {
        id: "dsh",
        name: "DeepSeek Harness",
        detect_bin: "dsh",
        aliases: &[],
        requires_model: true,
        endpoint_with_prefix: true,
        docs_url: "https://github.com/deepseek-ai/deepseek-harness",
        // A bare `dsh` has no profile to hand its arguments to and only prints
        // the launcher's help; `dsh web` serves the UI on 127.0.0.1:3080.
        run_args: &["web"],
        run_mode: RunMode::Terminal,
    },
    Agent {
        id: "zed",
        name: "Zed",
        detect_bin: "zed",
        aliases: &[],
        requires_model: true,
        endpoint_with_prefix: true,
        docs_url: "https://zed.dev/docs/ai/llm-providers",
        run_args: &[],
        // Zed's AI agent lives in its own window; the launcher returns at once.
        run_mode: RunMode::Gui,
    },
    Agent {
        id: "mimo",
        name: "MiMo Code",
        detect_bin: "mimo",
        aliases: &[],
        requires_model: true,
        endpoint_with_prefix: true,
        docs_url: "https://mimo.xiaomi.com/mimocode/",
        run_args: &[],
        run_mode: RunMode::Terminal,
    },
    Agent {
        id: "droid",
        name: "Droid",
        detect_bin: "droid",
        aliases: &[],
        requires_model: true,
        endpoint_with_prefix: true,
        docs_url: "https://docs.factory.ai/cli/getting-started/quickstart",
        run_args: &[],
        run_mode: RunMode::Terminal,
    },
    Agent {
        id: "copilot",
        name: "Copilot CLI",
        detect_bin: "copilot",
        aliases: &[],
        requires_model: true,
        endpoint_with_prefix: true,
        docs_url: "https://docs.github.com/en/copilot/how-tos/copilot-cli",
        run_args: &[],
        run_mode: RunMode::Terminal,
    },
    Agent {
        id: "openhands",
        name: "OpenHands",
        detect_bin: "openhands",
        aliases: &[],
        requires_model: true,
        endpoint_with_prefix: true,
        docs_url: "https://docs.openhands.dev/openhands/usage/cli/installation",
        // OpenHands reads the env overrides only with this flag.
        run_args: &["--override-with-envs"],
        run_mode: RunMode::Terminal,
    },
    Agent {
        id: "poolside",
        name: "Poolside",
        detect_bin: "pool",
        aliases: &["poolside"],
        requires_model: true,
        endpoint_with_prefix: true,
        docs_url: "https://docs.poolside.ai/cli",
        run_args: &[],
        run_mode: RunMode::Terminal,
    },
    Agent {
        id: "goose",
        name: "Goose",
        detect_bin: "goose",
        aliases: &[],
        requires_model: true,
        // Goose appends its own path via OPENAI_BASE_PATH.
        endpoint_with_prefix: false,
        docs_url: "https://block.github.io/goose/",
        // A bare `goose` only prints help.
        run_args: &["session"],
        run_mode: RunMode::Terminal,
    },
    Agent {
        id: "hermes",
        name: "Hermes Agent",
        detect_bin: "hermes",
        aliases: &[],
        requires_model: true,
        endpoint_with_prefix: true,
        docs_url: "https://github.com/NousResearch/hermes-agent",
        run_args: &[],
        run_mode: RunMode::Terminal,
    },
    Agent {
        id: "openclaw",
        name: "OpenClaw",
        detect_bin: "openclaw",
        aliases: &[],
        requires_model: true,
        endpoint_with_prefix: true,
        docs_url: "https://docs.openclaw.ai",
        // A bare `openclaw` is the setup/repair helper; `chat` runs the agent.
        run_args: &["chat"],
        run_mode: RunMode::Terminal,
    },
];

/// Hermes Agent refuses to start below a 64K context window; 65536 is the
/// minimum it accepts. Matches the Launch page.
const HERMES_CONTEXT_LENGTH: u32 = 65536;

/// Look an agent up by id, binary name, or alias. Case-insensitive.
pub fn find(name: &str) -> Option<&'static Agent> {
    let needle = name.trim().to_ascii_lowercase();
    AGENTS.iter().find(|a| {
        a.id == needle || a.detect_bin == needle || a.aliases.iter().any(|alias| *alias == needle)
    })
}

/// Build the endpoint an agent should be pointed at, mirroring the Launch page:
/// the bare base URL, plus the API prefix only when the agent expects it.
pub fn api_url_for(agent: &Agent, base_url: &str, prefix: &str) -> String {
    if agent.endpoint_with_prefix {
        format!("{base_url}{prefix}")
    } else {
        base_url.to_string()
    }
}

/// Write the agent's config, reusing the exact same functions the desktop
/// Launch page invokes.
pub fn configure(agent: &Agent, api_url: &str, model: &str, api_key: &str) -> Result<(), String> {
    let url = api_url.to_string();
    let model_owned = model.to_string();
    let key = Some(api_key.to_string());
    let model_opt = (!model.is_empty()).then(|| model.to_string());

    match agent.id {
        "kilo" => agents::configure_kilo(url, model_owned, key),
        "claude-code" => agents::configure_claude_code(url, model_opt, key),
        "pi" => agents::configure_pi(url, model_owned, key),
        "codex" => agents::configure_codex(url, model_owned, key),
        "opencode" => agents::configure_opencode(url, model_owned, key),
        "openclaude" => agents::configure_openclaude(url, model_owned, key),
        "cline" => agents::configure_cline(url, model_owned, key),
        "dsh" => agents::configure_dsh(url, model_owned, key),
        "zed" => agents::configure_zed(url, model_opt, key),
        "mimo" => agents::configure_mimo(url, model_owned, key),
        "droid" => agents::configure_droid(url, model_owned, key),
        "copilot" => agents::configure_copilot(url, model_owned, key),
        "openhands" => agents::configure_openhands(url, model_owned, key),
        "poolside" => agents::configure_poolside(url, model_owned, key),
        "goose" => agents::configure_goose(url, model_owned, key),
        "hermes" => {
            agents::configure_hermes_agent(url, model_owned, key, Some(HERMES_CONTEXT_LENGTH))
        }
        "openclaw" => agents::configure_openclaw(url, model_owned, key),
        other => Err(format!("Unknown agent: {other}")),
    }
}

/// Environment the spawned agent needs on top of whatever its config file says.
///
/// Four agents are configured purely through environment variables that
/// `configure_*` persists to the user's shell rc. That file is not live in a
/// process we are about to spawn, so the same variables are set directly on the
/// child. Everything else is configured through a file the agent reads itself
/// and needs no environment at all.
pub fn child_env(
    agent: &Agent,
    api_url: &str,
    model: &str,
    api_key: &str,
) -> Vec<(String, String)> {
    let key = Some(api_key);
    match agent.id {
        "copilot" => agents::copilot_env_vars(api_url, model, key),
        "goose" => agents::goose_env_vars(api_url, model, key),
        "openhands" => agents::openhands_env_vars(api_url, model, key),
        "poolside" => agents::poolside_env_vars(api_url, model, key),
        _ => Vec::new(),
    }
}

/// Provider credentials in the ambient environment that would override the
/// config we just wrote. Cleared on the child before launching.
pub const CONFLICTING_PROVIDER_ENV: &[&str] = &[
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_OAUTH_TOKEN",
    "GEMINI_API_KEY",
    "MISTRAL_API_KEY",
    "GROQ_API_KEY",
    "XAI_API_KEY",
    "OPENROUTER_API_KEY",
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_accepts_id_binary_and_alias() {
        assert_eq!(find("claude-code").unwrap().id, "claude-code");
        assert_eq!(find("claude").unwrap().id, "claude-code");
        assert_eq!(find("CLAUDE").unwrap().id, "claude-code");
        assert_eq!(find("pool").unwrap().id, "poolside");
        assert_eq!(find("poolside").unwrap().id, "poolside");
        assert!(find("definitely-not-an-agent").is_none());
    }

    #[test]
    fn api_url_respects_the_prefix_flag() {
        let claude = find("claude-code").unwrap();
        let codex = find("codex").unwrap();
        // Claude Code and Goose append their own path.
        assert_eq!(
            api_url_for(claude, "http://127.0.0.1:1337", "/v1"),
            "http://127.0.0.1:1337"
        );
        assert_eq!(
            api_url_for(find("goose").unwrap(), "http://127.0.0.1:1337", "/v1"),
            "http://127.0.0.1:1337"
        );
        assert_eq!(
            api_url_for(codex, "http://127.0.0.1:1337", "/v1"),
            "http://127.0.0.1:1337/v1"
        );
    }

    #[test]
    fn ids_are_unique_and_lowercase() {
        let mut seen = std::collections::HashSet::new();
        for a in AGENTS {
            assert!(seen.insert(a.id), "duplicate agent id: {}", a.id);
            assert_eq!(a.id, a.id.to_ascii_lowercase());
            for alias in a.aliases {
                assert_eq!(*alias, alias.to_ascii_lowercase());
            }
        }
    }

    /// The Rust catalog and `integrations.ts` must stay in sync, otherwise the
    /// CLI silently configures a different set of agents than the Launch page.
    /// The three GUI editors are expected to be absent here.
    #[test]
    fn catalog_matches_the_typescript_source() {
        const EDITORS: &[&str] = &["vscode", "jetbrains", "xcode"];

        let ts_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("workspace root")
            .join("web-app/src/constants/integrations.ts");
        let source = match std::fs::read_to_string(&ts_path) {
            Ok(s) => s,
            Err(e) => {
                // Rust-only checkouts (e.g. a vendored crate) have no web-app
                // at all. Anything else is a real failure, not a reason to pass
                // this test vacuously.
                if ts_path.parent().is_some_and(|p| p.exists()) {
                    panic!("cannot read {}: {e}", ts_path.display());
                }
                return;
            }
        };

        // Entries are indented four spaces inside INTEGRATION_AGENTS; the type
        // definitions above it have none, so the indent alone disambiguates.
        let ts_ids: Vec<&str> = source
            .lines()
            .filter_map(|line| line.strip_prefix("    id: '"))
            .filter_map(|rest| rest.split('\'').next())
            .filter(|id| !EDITORS.contains(id))
            .collect();

        assert!(
            !ts_ids.is_empty(),
            "could not parse any ids out of {}",
            ts_path.display()
        );

        let rust_ids: Vec<&str> = AGENTS.iter().map(|a| a.id).collect();
        assert_eq!(
            rust_ids, ts_ids,
            "agent catalog drifted from integrations.ts (order matters)"
        );
    }
}
