//! Goose: a connection writes nothing. The Launch page starts `goose session`
//! with its provider, model, endpoint, key and window in that one process's
//! environment (`integration-agent-run.ts`), so nothing outside it changes.
//!
//! Earlier releases saved the same variables for the whole user instead — a
//! marked block in the shell rc file, or `setx` on Windows — which made every
//! OpenAI SDK tool on the machine talk to Atomic Chat (`OPENAI_API_KEY`,
//! `OPENAI_HOST`). Connect and Disconnect take exactly that out again, and
//! nothing a user wrote.

use std::path::{Path, PathBuf};

use super::commands::agent_home_dir;

/// The line that opened and closed the block earlier releases wrote.
pub(crate) const LEGACY_SHELL_MARKER: &str = "# Atomic Chat - Goose Config";
/// The variables that block (or `setx`) held.
const LEGACY_VARS: [&str; 5] = [
    "GOOSE_PROVIDER",
    "GOOSE_MODEL",
    "OPENAI_HOST",
    "OPENAI_BASE_PATH",
    "OPENAI_API_KEY",
];
#[cfg_attr(not(windows), allow(dead_code))]
const LEGACY_BASE_PATH: &str = "v1/chat/completions";
/// The key written when the server had none.
#[cfg_attr(not(windows), allow(dead_code))]
const KEY_PLACEHOLDER: &str = "atomic";

/// The rc files `detect_shell_env_file` could have picked for the `$SHELL`
/// of the time.
fn legacy_rc_files(home: &Path) -> [PathBuf; 3] {
    [
        home.join(".zshenv"),
        home.join(".bashrc"),
        home.join(".bash_profile"),
    ]
}

fn is_legacy_export(line: &str) -> bool {
    line.trim_start()
        .strip_prefix("export ")
        .and_then(|rest| rest.split_once('='))
        .is_some_and(|(name, _)| LEGACY_VARS.contains(&name.trim()))
}

/// `content` without our Goose blocks, or `None` when it has none. A block
/// runs from one marker line to the next; within it only the marker lines,
/// our `export` lines and blank lines go — anything else a user put there
/// stays. A marker without a partner goes alone.
pub(crate) fn strip_legacy_block(content: &str) -> Option<String> {
    let lines: Vec<&str> = content.split('\n').collect();
    let markers: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, line)| line.starts_with(LEGACY_SHELL_MARKER))
        .map(|(i, _)| i)
        .collect();
    if markers.is_empty() {
        return None;
    }
    let in_block = |i: usize| {
        markers
            .chunks(2)
            .any(|pair| pair.len() == 2 && pair[0] < i && i < pair[1])
    };
    let kept: Vec<&str> = lines
        .iter()
        .enumerate()
        .filter(|(i, line)| {
            if markers.contains(i) {
                return false;
            }
            !(in_block(*i) && (line.trim().is_empty() || is_legacy_export(line)))
        })
        .map(|(_, line)| *line)
        .collect();
    Some(kept.join("\n"))
}

/// Remove our blocks from every rc file under `home`; the files changed.
pub(crate) fn remove_legacy_shell_blocks(home: &Path) -> Result<Vec<PathBuf>, String> {
    let mut changed = Vec::new();
    for rc in legacy_rc_files(home) {
        let Ok(content) = std::fs::read_to_string(&rc) else {
            continue;
        };
        if let Some(cleaned) = strip_legacy_block(&content) {
            std::fs::write(&rc, cleaned)
                .map_err(|e| format!("Failed to write {}: {}", rc.display(), e))?;
            changed.push(rc);
        }
    }
    Ok(changed)
}

/// The User-scope variables (`read` looks one up) that are recognisably
/// what an earlier release set with `setx`: Goose on the OpenAI provider with
/// our fixed base path at a local host. The key goes only when it is our
/// placeholder or the server's own key.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn legacy_user_vars(
    read: &dyn Fn(&str) -> Option<String>,
    api_key: Option<&str>,
) -> Vec<&'static str> {
    let ours = read("GOOSE_PROVIDER").as_deref().map(str::trim) == Some("openai")
        && read("OPENAI_BASE_PATH").as_deref().map(str::trim) == Some(LEGACY_BASE_PATH)
        && read("OPENAI_HOST")
            .is_some_and(|host| super::agent_config_detection::is_local_url(&host));
    if !ours {
        return Vec::new();
    }
    LEGACY_VARS
        .into_iter()
        .filter(|name| match read(name) {
            None => false,
            Some(value) if *name == "OPENAI_API_KEY" => {
                value == KEY_PLACEHOLDER || api_key.is_some_and(|k| !k.is_empty() && k == value)
            }
            Some(_) => true,
        })
        .collect()
}

/// Delete `names` from `HKCU\Environment` the way `setx` set them, telling
/// running programs (Explorer) the environment changed, and from this
/// process too, so a terminal opened from here does not inherit them.
#[cfg(windows)]
fn remove_user_vars(names: &[&str]) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    // `SetEnvironmentVariable(…, $null, 'User')` deletes the value and
    // broadcasts WM_SETTINGCHANGE. The names are our constants.
    let script = names
        .iter()
        .map(|name| format!("[Environment]::SetEnvironmentVariable('{name}', $null, 'User')"))
        .collect::<Vec<_>>()
        .join("; ");
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
        .map_err(|e| format!("Failed to run PowerShell: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "Could not remove the Goose variables an earlier Atomic Chat set: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    for name in names {
        std::env::remove_var(name);
    }
    Ok(())
}

/// Take out what earlier releases saved for Goose user-wide.
pub(crate) fn remove_legacy(api_key: Option<&str>) -> Result<(), String> {
    let home = agent_home_dir()?;
    for rc in remove_legacy_shell_blocks(Path::new(&home))? {
        log::info!(
            "Removed the Goose block an earlier release wrote to {}",
            rc.display()
        );
    }
    #[cfg(windows)]
    {
        let names = legacy_user_vars(&super::agent_config_detection::read_user_env, api_key);
        if !names.is_empty() {
            remove_user_vars(&names)?;
            log::info!("Removed the Goose user variables an earlier release set: {names:?}");
        }
    }
    #[cfg(not(windows))]
    let _ = api_key;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    const BLOCK: &str = "# Atomic Chat - Goose Config\n\
        export GOOSE_PROVIDER='openai'\n\
        export GOOSE_MODEL='qwen3'\n\
        export OPENAI_HOST='http://127.0.0.1:1337'\n\
        export OPENAI_BASE_PATH='v1/chat/completions'\n\
        export OPENAI_API_KEY='atomic'\n\
        \n\
        # Atomic Chat - Goose Config\n";

    #[test]
    fn the_old_block_goes_and_the_users_lines_stay() {
        let user = "export OPENAI_API_KEY='sk-user-owned'\nexport EDITOR=nvim\n";
        assert_eq!(
            strip_legacy_block(&format!("{user}{BLOCK}")).as_deref(),
            Some(user)
        );
        assert_eq!(strip_legacy_block(user), None);
        // A line of the user's inside the block is not ours to remove.
        let edited = BLOCK.replace("export GOOSE_MODEL='qwen3'\n", "alias g=goose\n");
        assert_eq!(
            strip_legacy_block(&format!("A=1\n{edited}")).as_deref(),
            Some("A=1\nalias g=goose\n")
        );
        // A lone marker: nothing after it is taken for ours.
        assert_eq!(
            strip_legacy_block("# Atomic Chat - Goose Config\nexport OPENAI_API_KEY='sk'\n")
                .as_deref(),
            Some("export OPENAI_API_KEY='sk'\n")
        );
    }

    #[test]
    fn every_rc_file_is_cleaned_and_others_untouched() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        std::fs::write(h.join(".zshenv"), format!("export A=1\n{BLOCK}")).unwrap();
        std::fs::write(h.join(".bash_profile"), BLOCK).unwrap();
        std::fs::write(h.join(".bashrc"), "export B=2\n").unwrap();
        let changed = remove_legacy_shell_blocks(h).unwrap();
        assert_eq!(changed, vec![h.join(".zshenv"), h.join(".bash_profile")]);
        assert_eq!(
            std::fs::read_to_string(h.join(".zshenv")).unwrap(),
            "export A=1\n"
        );
        assert_eq!(
            std::fs::read_to_string(h.join(".bash_profile")).unwrap(),
            ""
        );
        assert_eq!(
            std::fs::read_to_string(h.join(".bashrc")).unwrap(),
            "export B=2\n"
        );
        // Nothing left: a second pass changes nothing.
        assert!(remove_legacy_shell_blocks(h).unwrap().is_empty());
    }

    #[test]
    fn only_the_variables_an_earlier_release_set_are_ours() {
        let ours: HashMap<&str, &str> = HashMap::from([
            ("GOOSE_PROVIDER", "openai"),
            ("GOOSE_MODEL", "qwen3"),
            ("OPENAI_HOST", "http://127.0.0.1:1337"),
            ("OPENAI_BASE_PATH", "v1/chat/completions"),
            ("OPENAI_API_KEY", "sk-real-openai"),
        ]);
        let read = |name: &str| ours.get(name).map(|v| v.to_string());
        // A key that is neither the placeholder nor the server's stays.
        assert_eq!(
            legacy_user_vars(&read, Some("sk-server")),
            vec![
                "GOOSE_PROVIDER",
                "GOOSE_MODEL",
                "OPENAI_HOST",
                "OPENAI_BASE_PATH"
            ]
        );
        assert_eq!(legacy_user_vars(&read, Some("sk-real-openai")).len(), 5);

        // The user's own Goose on a remote OpenAI host is not ours at all.
        let theirs: HashMap<&str, &str> = HashMap::from([
            ("GOOSE_PROVIDER", "openai"),
            ("OPENAI_HOST", "https://api.openai.com"),
            ("OPENAI_BASE_PATH", "v1/chat/completions"),
            ("OPENAI_API_KEY", "atomic"),
        ]);
        let read = |name: &str| theirs.get(name).map(|v| v.to_string());
        assert!(legacy_user_vars(&read, None).is_empty());
    }
}
