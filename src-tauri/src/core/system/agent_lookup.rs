//! Where a terminal agent's launcher can be when `which`/`where` misses it,
//! and the session caches the lookups behind that use.
//!
//! Most installers put the launcher in a per-user bin directory and leave PATH
//! to the user's next shell: Claude Code's native installer, `uv tool install`
//! (OpenHands), Goose, Poolside and Hermes write `~/.local/bin`; npm writes its
//! global prefix. A shell that has not reloaded — or a GUI app whose login-shell
//! PATH was read before the install — cannot see them, and the Launch page then
//! offered to install a second copy.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

/// The detect binaries of the terminal agents (`detectBin` in the web
/// catalog). Editors and desktop apps keep their own candidates.
const TERMINAL_AGENT_BINS: &[&str] = &[
    "claude",
    "codex",
    "opencode",
    "openclaude",
    "cline",
    "mimo",
    "droid",
    "copilot",
    "pi",
    "dsh",
    "kilo",
    "openhands",
    "goose",
    "pool",
    "muse",
    "atomic-agent",
    "hermes",
    "openclaw",
];

/// Whether `bin` is a terminal agent's launcher (and not an editor's or a
/// desktop app's).
pub(crate) fn is_terminal_agent(bin: &str) -> bool {
    TERMINAL_AGENT_BINS.contains(&bin)
}

/// The directory `uv tool install` links executables into, by uv's own
/// order: `$UV_TOOL_BIN_DIR`, `$XDG_BIN_HOME`, `$XDG_DATA_HOME/../bin`,
/// `~/.local/bin` (the same on Windows, under the user profile).
pub(crate) fn uv_tool_bin_dir(env: &dyn Fn(&str) -> Option<String>, home: &Path) -> PathBuf {
    let set = |name: &str| env(name).filter(|v| !v.trim().is_empty());
    if let Some(dir) = set("UV_TOOL_BIN_DIR").or_else(|| set("XDG_BIN_HOME")) {
        return PathBuf::from(dir);
    }
    if let Some(data) = set("XDG_DATA_HOME") {
        return PathBuf::from(data).join("..").join("bin");
    }
    home.join(".local").join("bin")
}

/// Launcher paths to try for a terminal agent missing from PATH: the
/// per-user bin directory, uv's tool bin directory, npm's global bin
/// directory (`npm_bin`, from `npm prefix -g`) and, on Windows, npm's default
/// `%APPDATA%\npm`. Empty for anything that is not a terminal agent.
pub(crate) fn terminal_agent_candidates(
    bin: &str,
    home: &Path,
    env: &dyn Fn(&str) -> Option<String>,
    npm_bin: Option<&Path>,
    windows: bool,
) -> Vec<PathBuf> {
    if !is_terminal_agent(bin) {
        return Vec::new();
    }
    let mut dirs: Vec<PathBuf> = vec![home.join(".local").join("bin"), uv_tool_bin_dir(env, home)];
    if let Some(npm_bin) = npm_bin {
        dirs.push(npm_bin.to_path_buf());
    }
    if windows {
        if let Some(appdata) = env("APPDATA").filter(|v| !v.trim().is_empty()) {
            dirs.push(PathBuf::from(appdata).join("npm"));
        }
    }
    let mut unique: Vec<PathBuf> = Vec::new();
    for dir in dirs {
        if !unique.contains(&dir) {
            unique.push(dir);
        }
    }
    // Native installers write `.exe`; npm writes a `.cmd` shim (and a `.ps1`
    // and an sh script, which `cmd /K` cannot start).
    let names: Vec<String> = if windows {
        vec![format!("{bin}.exe"), format!("{bin}.cmd")]
    } else {
        vec![bin.to_string()]
    };
    unique
        .iter()
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .collect()
}

/// npm's global bin directory for a `npm prefix -g` answer: `<prefix>\` on
/// Windows, `<prefix>/bin` elsewhere.
pub(crate) fn npm_bin_from_prefix(stdout: &str, windows: bool) -> Option<PathBuf> {
    let prefix = stdout.lines().map(str::trim).rfind(|l| !l.is_empty())?;
    let prefix = PathBuf::from(prefix);
    Some(if windows { prefix } else { prefix.join("bin") })
}

static NPM_GLOBAL_BIN: Mutex<Option<Option<PathBuf>>> = Mutex::new(None);

/// npm's global bin directory, asked once per session (and again after an
/// install, see [`forget_install_lookups`]). `None` without a working npm.
pub(crate) fn npm_global_bin() -> Option<PathBuf> {
    let mut cached = NPM_GLOBAL_BIN.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(found) = cached.as_ref() {
        return found.clone();
    }
    let found = ask_npm_prefix();
    *cached = Some(found.clone());
    found
}

fn ask_npm_prefix() -> Option<PathBuf> {
    let mut cmd = if cfg!(windows) {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "npm", "prefix", "-g"]);
        c
    } else {
        let mut c = std::process::Command::new("npm");
        c.args(["prefix", "-g"]);
        c
    };
    super::commands::apply_tool_path(&mut cmd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let (status, out) = super::agent_process::output_within(cmd, Duration::from_secs(5))?;
    if !status.success() {
        return None;
    }
    npm_bin_from_prefix(&String::from_utf8_lossy(&out), cfg!(windows))
}

/// Drop what a detection pass cached about where tools live: an install has
/// just changed it (a new `~/.local/bin`, a PATH line in a shell rc file).
pub(crate) fn forget_install_lookups() {
    *NPM_GLOBAL_BIN.lock().unwrap_or_else(|e| e.into_inner()) = None;
    super::commands::forget_login_shell_path();
}

/// A bundled tool next to the app executable (Tauri `externalBin`) or in the
/// bundled `resources/bin`, as it is named on this platform.
pub(crate) fn bundled_tool(dirs: &[PathBuf], name: &str) -> Option<PathBuf> {
    let file = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    dirs.iter().map(|dir| dir.join(&file)).find(|p| p.is_file())
}

// ---------------------------------------------------------------------------
// WSL
// ---------------------------------------------------------------------------

// The WSL helpers below only have callers on Windows; the tests run everywhere.

/// Distributions that are not a user's shell: Docker Desktop's internal ones
/// and the one Atomic Chat runs its GPU engines in. Probing them would boot a
/// VM that has nothing to do with the user's agents.
#[cfg_attr(not(windows), allow(dead_code))]
const NON_USER_DISTRIBUTIONS: &[&str] = &["AtomicChat", "docker-desktop", "docker-desktop-data"];

/// `wsl.exe` prints UTF-16LE unless `WSL_UTF8=1` took effect; accept both.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn decode_wsl_output(bytes: &[u8]) -> String {
    let looks_utf16 = bytes.len() >= 2
        && bytes.iter().skip(1).step_by(2).filter(|b| **b == 0).count() * 2 >= bytes.len() / 2;
    if looks_utf16 {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
    .trim_start_matches('\u{feff}')
    .to_string()
}

/// The distribution to look for agents in, from `wsl.exe --list --verbose`:
/// the default one (marked `*`) unless it is not a user's, else the first
/// user distribution. `None` when there is no user distribution at all.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn pick_wsl_distribution(list_verbose: &str) -> Option<String> {
    let mut first_user: Option<String> = None;
    for line in list_verbose.lines() {
        let line = line.trim_matches(|c: char| c == '\0' || c.is_whitespace());
        let (default, rest) = match line.strip_prefix('*') {
            Some(rest) => (true, rest.trim_start()),
            None => (false, line),
        };
        // Rows are `NAME  STATE  VERSION`; the header row's last column is
        // not a number in any locale.
        let columns: Vec<&str> = rest.split_whitespace().collect();
        if columns.len() < 3 || columns[columns.len() - 1].parse::<u8>().is_err() {
            continue;
        }
        // A name may contain spaces only in the middle of the row.
        let name = columns[..columns.len() - 2].join(" ");
        if NON_USER_DISTRIBUTIONS
            .iter()
            .any(|n| n.eq_ignore_ascii_case(&name))
        {
            continue;
        }
        if default {
            return Some(name);
        }
        first_user.get_or_insert(name);
    }
    first_user
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_env(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn terminal_agents_are_looked_for_in_the_user_bin_dirs() {
        let home = Path::new("/home/u");
        let npm = Path::new("/opt/npm-global/bin");
        let found = terminal_agent_candidates("claude", home, &no_env, Some(npm), false);
        assert_eq!(
            found,
            [
                PathBuf::from("/home/u/.local/bin/claude"),
                PathBuf::from("/opt/npm-global/bin/claude"),
            ]
        );
        assert!(terminal_agent_candidates("code", home, &no_env, Some(npm), false).is_empty());
        assert!(terminal_agent_candidates("zcode", home, &no_env, None, false).is_empty());
    }

    #[test]
    fn windows_candidates_cover_native_exes_and_npm_shims() {
        let env = |name: &str| match name {
            "APPDATA" => Some(r"C:\Users\Миша\AppData\Roaming".to_string()),
            _ => None,
        };
        let home = Path::new(r"C:\Users\Миша");
        let found: Vec<String> = terminal_agent_candidates("codex", home, &env, None, true)
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        let local = home.join(".local").join("bin");
        assert!(found.contains(&local.join("codex.exe").to_string_lossy().into_owned()));
        assert!(found.contains(&local.join("codex.cmd").to_string_lossy().into_owned()));
        assert!(found
            .iter()
            .any(|p| p.ends_with("codex.cmd") && p.contains(r"Roaming") && p.contains("npm")));
        assert!(found
            .iter()
            .all(|p| p.ends_with(".exe") || p.ends_with(".cmd")));
    }

    #[test]
    fn uv_tool_bin_dir_follows_uvs_order() {
        let home = Path::new("/home/u");
        assert_eq!(
            uv_tool_bin_dir(&no_env, home),
            PathBuf::from("/home/u/.local/bin")
        );
        let xdg_data = |n: &str| (n == "XDG_DATA_HOME").then(|| "/data/share".to_string());
        assert_eq!(
            uv_tool_bin_dir(&xdg_data, home),
            PathBuf::from("/data/share/../bin")
        );
        let all = |n: &str| match n {
            "UV_TOOL_BIN_DIR" => Some("/uv/bin".to_string()),
            "XDG_BIN_HOME" => Some("/xdg/bin".to_string()),
            _ => None,
        };
        assert_eq!(uv_tool_bin_dir(&all, home), PathBuf::from("/uv/bin"));
        // A custom uv dir is a candidate of its own.
        let custom = terminal_agent_candidates("openhands", home, &all, None, false);
        assert!(custom.contains(&PathBuf::from("/uv/bin/openhands")));
    }

    #[test]
    fn npm_prefix_answers_map_to_its_bin_dir() {
        assert_eq!(
            npm_bin_from_prefix("/usr/local\n", false),
            Some(PathBuf::from("/usr/local/bin"))
        );
        assert_eq!(
            npm_bin_from_prefix(
                "npm notice something\r\nC:\\Users\\u\\AppData\\Roaming\\npm\r\n",
                true
            ),
            Some(PathBuf::from(r"C:\Users\u\AppData\Roaming\npm"))
        );
        assert_eq!(npm_bin_from_prefix("  \n", false), None);
    }

    #[test]
    fn wsl_output_decodes_from_utf16_and_utf8() {
        let text =
            "  NAME            STATE           VERSION\n* Ubuntu          Stopped         2\n";
        let utf16: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert_eq!(decode_wsl_output(&utf16), text);
        assert_eq!(decode_wsl_output(text.as_bytes()), text);
    }

    #[test]
    fn picks_the_users_default_distribution_and_skips_ours() {
        let list = "  NAME                   STATE           VERSION\n\
                    * AtomicChat             Running         2\n  \
                    docker-desktop         Stopped         2\n  \
                    Ubuntu-24.04           Stopped         2\n  \
                    Debian                 Stopped         2\n";
        assert_eq!(
            pick_wsl_distribution(list),
            Some("Ubuntu-24.04".to_string())
        );

        let default_user =
            "  ИМЯ      СОСТОЯНИЕ     ВЕРСИЯ\n  Ubuntu   Stopped   2\n* Debian   Running   2\n";
        assert_eq!(
            pick_wsl_distribution(default_user),
            Some("Debian".to_string())
        );

        let only_ours = "  NAME   STATE   VERSION\n* AtomicChat   Stopped   2\n";
        assert_eq!(pick_wsl_distribution(only_ours), None);
        assert_eq!(pick_wsl_distribution(""), None);
    }
}
