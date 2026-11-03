//! Disconnect for every agent Atomic Chat connects: one command, and one
//! function per agent that undoes what its `configure_*` writer did — our
//! entries, the model and endpoint it selected, the environment it saved —
//! restoring what the user had before where the writer kept it. Each returns
//! `Ok(())` when there is nothing of ours left. Connections → Disconnect
//! forgets the row only once this succeeded.

/// Undo the connection `agent_id` (an `integrations.ts` id) made.
#[tauri::command]
pub async fn disconnect_agent(agent_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || disconnect_blocking(&agent_id))
        .await
        .map_err(|e| e.to_string())?
}

fn disconnect_blocking(agent_id: &str) -> Result<(), String> {
    match agent_id {
        "codex" => {
            let home = super::codex_config::resolve_codex_home()?;
            super::codex_config::disconnect_in(&home)
        }
        "claude-code" => disconnect_claude_code(),
        "openclaude" => disconnect_openclaude(),
        "kilo" => disconnect_kilo(),
        "opencode" => disconnect_opencode(),
        "mimo" => disconnect_mimo(),
        "pi" => disconnect_pi(),
        "goose" => disconnect_goose(),
        "cline" => disconnect_cline(),
        "droid" => disconnect_droid(),
        "copilot" => disconnect_copilot(),
        "dsh" => disconnect_dsh(),
        "hermes" => disconnect_hermes(),
        "openclaw" => disconnect_openclaw(),
        "atomic-agent" => disconnect_atomic_agent(),
        "openhands" => disconnect_openhands(),
        "poolside" => disconnect_poolside(),
        "muse" => disconnect_muse(),
        "zed" => disconnect_zed(),
        "zcode" => disconnect_zcode(),
        other => Err(format!("Unknown agent: {other}")),
    }
}

/// claude-code: put back the `settings.json` values Connect replaced, and
/// take out the environment the old Claude Code settings page exported.
fn disconnect_claude_code() -> Result<(), String> {
    use super::claude_config as cc;
    let server = cc::OurServer::from_app_state();
    cc::disconnect_claude_code(&cc::resolve_claude_settings_path()?, &server)?;
    let home = super::commands::agent_home_dir()?;
    cc::forget_legacy_claude_code_env(std::path::Path::new(&home), &server)
}

/// openclaude: put back the active profile and env values Connect replaced,
/// drop our provider profile, and restore the startup profile file.
fn disconnect_openclaude() -> Result<(), String> {
    use super::claude_config as cc;
    cc::disconnect_openclaude(
        &cc::resolve_openclaude_paths()?,
        &cc::OurServer::from_app_state(),
    )
}

/// kilo: our provider and `model` out of `kilo.jsonc`, the replaced ones back.
fn disconnect_kilo() -> Result<(), String> {
    super::opencode_family::disconnect_opencode_style(
        &super::opencode_family::FamilyPaths::resolve()?.kilo,
    )
}

/// opencode: our provider and `model` out, the replaced ones back.
fn disconnect_opencode() -> Result<(), String> {
    super::opencode_family::disconnect_opencode_style(
        &super::opencode_family::FamilyPaths::resolve()?.opencode,
    )
}

/// mimo: our provider and `model` out, the replaced ones back.
fn disconnect_mimo() -> Result<(), String> {
    super::opencode_family::disconnect_opencode_style(
        &super::opencode_family::FamilyPaths::resolve()?.mimo,
    )
}

/// pi: our provider, default model and compaction override out, the
/// replaced default back.
fn disconnect_pi() -> Result<(), String> {
    super::opencode_family::disconnect_pi(&super::opencode_family::FamilyPaths::resolve()?.pi_dir)
}

/// goose: a connection writes nothing; what earlier releases saved user-wide
/// goes.
fn disconnect_goose() -> Result<(), String> {
    super::goose_config::remove_legacy(None)
}

/// cline: the provider entry and `lastUsedProvider` from before Connect.
fn disconnect_cline() -> Result<(), String> {
    super::cline_config::disconnect_in(&super::cline_config::resolve_providers_path()?)
}

/// droid: our `customModels` entry, and the default model from before.
fn disconnect_droid() -> Result<(), String> {
    let home = super::commands::agent_home_dir()?;
    super::droid_config::disconnect_in(&super::droid_config::settings_path(std::path::Path::new(
        &home,
    )))
}

/// copilot: our `providers.json` entries, and what earlier releases set.
fn disconnect_copilot() -> Result<(), String> {
    super::copilot_config::disconnect()
}

/// dsh: our route, the default model from before, and our key.
fn disconnect_dsh() -> Result<(), String> {
    super::commands::disconnect_dsh_at(&super::commands::dsh_home_dir()?)
}

/// hermes: restore the `model:` keys Connect replaced, drop our provider entry
/// and what Connect created.
fn disconnect_hermes() -> Result<(), String> {
    super::commands::disconnect_hermes_at(&super::commands::resolve_hermes_dir()?)
}

/// openclaw: restore the keys Connect overwrote and drop our provider.
fn disconnect_openclaw() -> Result<(), String> {
    super::commands::disconnect_openclaw()
}

/// atomic-agent: restore the active providers and drop our entry.
fn disconnect_atomic_agent() -> Result<(), String> {
    super::commands::disconnect_atomic_agent()
}

/// openhands: remove what an older release persisted (it now gets its
/// environment at launch only).
fn disconnect_openhands() -> Result<(), String> {
    super::commands::remove_legacy_env_agent_config("openhands", None)
}

/// poolside: as OpenHands.
fn disconnect_poolside() -> Result<(), String> {
    super::commands::remove_legacy_env_agent_config("poolside", None)
}

/// muse: as OpenHands.
fn disconnect_muse() -> Result<(), String> {
    super::commands::remove_legacy_env_agent_config("muse", None)
}

/// zed: drop our provider; restore the agent's default model while it is ours.
fn disconnect_zed() -> Result<(), String> {
    super::commands::disconnect_zed_in(&super::commands::zed_config_dir()?)
}

/// zcode: drop our provider and rules; restore the default model while it is ours.
fn disconnect_zcode() -> Result<(), String> {
    super::commands::disconnect_zcode_in(&super::commands::resolve_zcode_config_dir()?)
}
