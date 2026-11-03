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

/// claude-code: nothing to undo yet.
fn disconnect_claude_code() -> Result<(), String> {
    Ok(())
}

/// openclaude: nothing to undo yet.
fn disconnect_openclaude() -> Result<(), String> {
    Ok(())
}

/// kilo: nothing to undo yet.
fn disconnect_kilo() -> Result<(), String> {
    Ok(())
}

/// opencode: nothing to undo yet.
fn disconnect_opencode() -> Result<(), String> {
    Ok(())
}

/// mimo: nothing to undo yet.
fn disconnect_mimo() -> Result<(), String> {
    Ok(())
}

/// pi: nothing to undo yet.
fn disconnect_pi() -> Result<(), String> {
    Ok(())
}

/// goose: nothing to undo yet.
fn disconnect_goose() -> Result<(), String> {
    Ok(())
}

/// cline: nothing to undo yet.
fn disconnect_cline() -> Result<(), String> {
    Ok(())
}

/// droid: nothing to undo yet.
fn disconnect_droid() -> Result<(), String> {
    Ok(())
}

/// copilot: nothing to undo yet.
fn disconnect_copilot() -> Result<(), String> {
    Ok(())
}

/// dsh: nothing to undo yet.
fn disconnect_dsh() -> Result<(), String> {
    Ok(())
}

/// hermes: nothing to undo yet.
fn disconnect_hermes() -> Result<(), String> {
    Ok(())
}

/// openclaw: nothing to undo yet.
fn disconnect_openclaw() -> Result<(), String> {
    Ok(())
}

/// atomic-agent: nothing to undo yet.
fn disconnect_atomic_agent() -> Result<(), String> {
    Ok(())
}

/// openhands: nothing to undo yet.
fn disconnect_openhands() -> Result<(), String> {
    Ok(())
}

/// poolside: nothing to undo yet.
fn disconnect_poolside() -> Result<(), String> {
    Ok(())
}

/// muse: nothing to undo yet.
fn disconnect_muse() -> Result<(), String> {
    Ok(())
}

/// zed: nothing to undo yet.
fn disconnect_zed() -> Result<(), String> {
    Ok(())
}

/// zcode: nothing to undo yet.
fn disconnect_zcode() -> Result<(), String> {
    Ok(())
}
