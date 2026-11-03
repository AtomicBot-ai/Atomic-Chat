//! The value an agent will see for a variable that relocates its config
//! directory (`CODEX_HOME`, `DSH_HOME`, `COPILOT_HOME`), when Atomic Chat's own
//! environment does not have it.
//!
//! The agent runs in the terminal Atomic Chat opens, so it sees the user's
//! shell environment, while the app does not: an `export CODEX_HOME=...` in
//! `~/.zshrc` is invisible to a Finder/Dock-launched app, and on Windows a
//! User-scope variable set after the app started is invisible to
//! `std::env::var`. Without looking where the agent looks, a writer would put
//! its file in the default directory while the agent reads another one.

/// `name` as the agent will see it: Windows' User environment first (it is
/// always current), then this process, then (macOS/Linux) the user's login
/// shell. Empty values count as unset.
pub(crate) fn agent_env_var(name: &str) -> Option<String> {
    let non_empty = |v: String| {
        let v = v.trim().to_string();
        (!v.is_empty()).then_some(v)
    };
    windows_user_env(name)
        .and_then(non_empty)
        .or_else(|| std::env::var(name).ok().and_then(non_empty))
        .or_else(|| login_shell_var(name).and_then(non_empty))
}

/// A User-scope variable from `HKCU\Environment`, read from the registry so a
/// non-ASCII path survives (a PowerShell probe would hand it back in the OEM
/// code page). `%VAR%` references in an expandable value are expanded.
#[cfg(windows)]
fn windows_user_env(name: &str) -> Option<String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let raw: String = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Environment")
        .ok()?
        .get_value(name)
        .ok()?;
    Some(expand_percent_vars(&raw, |var| std::env::var(var).ok()))
}

#[cfg(not(windows))]
fn windows_user_env(_name: &str) -> Option<String> {
    None
}

/// Expand `%VAR%` the way Windows does: an unknown variable stays as written.
#[cfg_attr(not(windows), allow(dead_code))]
fn expand_percent_vars(raw: &str, lookup: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) if end > 0 => {
                let var = &after[..end];
                match lookup(var) {
                    Some(value) => out.push_str(&value),
                    None => {
                        out.push('%');
                        out.push_str(var);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            _ => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// The variables the agent writers look up. The login shell is asked for all
/// of them at once: the probe starts an interactive shell, far too slow to
/// repeat, so its answer is kept for the life of the app.
const PROBED: &[&str] = &[
    "CODEX_HOME",
    "DSH_HOME",
    "COPILOT_HOME",
    "COPILOT_PROVIDERS_CONFIG",
    "CLINE_DIR",
    "CLINE_DATA_DIR",
    "CLINE_PROVIDER_SETTINGS_PATH",
];

/// `$name` in the user's interactive login shell, for the names in [`PROBED`].
#[cfg(not(windows))]
fn login_shell_var(name: &str) -> Option<String> {
    use std::collections::HashMap;
    use std::sync::OnceLock;

    static CACHE: OnceLock<HashMap<String, String>> = OnceLock::new();
    if !PROBED.contains(&name) {
        return None;
    }
    CACHE.get_or_init(probe_login_shell).get(name).cloned()
}

#[cfg(not(windows))]
fn probe_login_shell() -> std::collections::HashMap<String, String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    // Only the fixed names above reach the shell, never a value.
    let script: String = PROBED
        .iter()
        .map(|name| format!("printf '__ATOMICENV_{name}=%s__ATOMICEND__' \"${name}\";"))
        .collect();
    let Ok(out) = std::process::Command::new(shell)
        .args(["-lic", &script])
        .output()
    else {
        return Default::default();
    };
    if !out.status.success() {
        return Default::default();
    }
    parse_probe(&String::from_utf8_lossy(&out.stdout))
}

/// The `__ATOMICENV_<name>=<value>__ATOMICEND__` records in the probe's
/// output; anything an rc file printed around them is ignored.
#[cfg_attr(windows, allow(dead_code))]
fn parse_probe(text: &str) -> std::collections::HashMap<String, String> {
    let mut found = std::collections::HashMap::new();
    for name in PROBED {
        let open = format!("__ATOMICENV_{name}=");
        let Some(start) = text.find(&open).map(|i| i + open.len()) else {
            continue;
        };
        let Some(len) = text[start..].find("__ATOMICEND__") else {
            continue;
        };
        let value = text[start..start + len].trim();
        if !value.is_empty() {
            found.insert(name.to_string(), value.to_string());
        }
    }
    found
}

#[cfg(windows)]
fn login_shell_var(_name: &str) -> Option<String> {
    None
}

/// Expand a leading `~` against `home`: a quoted `CODEX_HOME="~/x"` in an rc
/// file reaches us unexpanded.
pub(crate) fn expand_home(value: &str, home: &std::path::Path) -> std::path::PathBuf {
    match value {
        "~" => home.to_path_buf(),
        v if v.starts_with("~/") || v.starts_with("~\\") => home.join(&v[2..]),
        v => std::path::PathBuf::from(v),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    #[test]
    fn percent_variables_expand_like_windows() {
        let lookup = |v: &str| (v == "USERPROFILE").then(|| "C:\\Users\\Миша".to_string());
        assert_eq!(
            expand_percent_vars("%USERPROFILE%\\.codex", lookup),
            "C:\\Users\\Миша\\.codex"
        );
        assert_eq!(expand_percent_vars("%NOPE%\\x", lookup), "%NOPE%\\x");
        assert_eq!(expand_percent_vars("50%", lookup), "50%");
        assert_eq!(expand_percent_vars("a%%b", lookup), "a%%b");
    }

    #[test]
    fn home_is_expanded() {
        let home = Path::new("/home/u");
        assert_eq!(expand_home("~", home), PathBuf::from("/home/u"));
        assert_eq!(expand_home("~/cx", home), PathBuf::from("/home/u/cx"));
        assert_eq!(expand_home("/opt/cx", home), PathBuf::from("/opt/cx"));
    }

    #[test]
    fn probe_output_is_read_past_rc_noise() {
        let text = "Welcome!\n__ATOMICENV_CODEX_HOME=/opt/cx__ATOMICEND__\
                    __ATOMICENV_DSH_HOME=__ATOMICEND__\
                    __ATOMICENV_COPILOT_HOME= ~/cp __ATOMICEND__bye";
        let found = parse_probe(text);
        assert_eq!(found.get("CODEX_HOME").map(String::as_str), Some("/opt/cx"));
        assert_eq!(found.get("COPILOT_HOME").map(String::as_str), Some("~/cp"));
        assert!(!found.contains_key("DSH_HOME"));
    }

    #[cfg(not(windows))]
    #[test]
    fn only_known_names_are_probed() {
        assert_eq!(login_shell_var("PATH"), None);
    }
}
