//! The terminal `open_agent_terminal` starts an integration agent in.
//!
//! On macOS and Linux the agent is not typed into the terminal: a short-lived
//! launcher script (mode 0700, deleted by its first line) carries the proxy
//! environment, sets the window title, prints one line saying which agent is
//! talking to which endpoint and model, and `exec`s the agent. Keys passed as
//! environment never reach the shell's history or the terminal's command line.
//!
//! macOS drives Terminal.app through `osascript` and waits for its answer, so
//! a launch Terminal refused (Automation not allowed, error -1743) is an error
//! rather than "opened". The window it opened is remembered per agent: while
//! the agent still runs there, the next Connect brings that window forward
//! instead of opening a second one.
//!
//! Linux tries the user's terminal (`$TERMINAL`, `xdg-terminal-exec`) and then
//! the common emulators, running the script through the user's own login shell
//! so its PATH (nvm, volta, ~/.local/bin) is the one they work with. An
//! emulator that exits at once with an error counts as not opened.

use std::path::Path;
#[cfg(unix)]
use std::path::PathBuf;

/// What a terminal is opened for: its title, the line printed before the
/// agent starts, and the key its window is remembered by.
#[derive(serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentTerminalInfo {
    /// The `integrations.ts` id.
    #[cfg_attr(windows, allow(dead_code))]
    pub agent_id: String,
    pub agent_name: String,
    /// The URL the agent's config points at.
    pub endpoint: String,
    pub model: Option<String>,
}

/// What `open_agent_terminal` did.
#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TerminalOutcome {
    /// A new terminal runs the agent.
    Opened,
    /// The terminal already running this agent was brought forward.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Focused,
}

/// How long the launcher script may wait to be run before it is deleted
/// anyway. It deletes itself as it starts; this only covers a terminal that
/// never ran it.
#[cfg(unix)]
const LAUNCHER_FALLBACK_CLEANUP: std::time::Duration = std::time::Duration::from_secs(120);

/// Control characters (newlines, ESC, BEL) dropped: a model id must not end
/// the title escape sequence or start one of its own.
fn one_line(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .trim()
        .to_string()
}

/// "Atomic Chat – Claude Code".
pub(crate) fn terminal_title(agent_name: &str) -> String {
    format!("Atomic Chat \u{2013} {}", one_line(agent_name))
}

/// "Atomic Chat · Claude Code → http://127.0.0.1:1337 · qwen3.5-9b".
#[cfg_attr(windows, allow(dead_code))]
pub(crate) fn banner_line(info: &AgentTerminalInfo) -> String {
    let mut line = format!(
        "Atomic Chat \u{b7} {} \u{2192} {}",
        one_line(&info.agent_name),
        one_line(&info.endpoint)
    );
    if let Some(model) = info
        .model
        .as_deref()
        .map(one_line)
        .filter(|m| !m.is_empty())
    {
        line.push_str(" \u{b7} ");
        line.push_str(&model);
    }
    line
}

/// The banner for `cmd.exe`'s `echo`, which has no quoting: only characters
/// it prints as they are survive, and ASCII separators replace the arrows the
/// console code page may not have.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn windows_echo_line(info: &AgentTerminalInfo) -> String {
    let mut line = format!("Atomic Chat - {} - {}", info.agent_name, info.endpoint);
    if let Some(model) = info.model.as_deref().filter(|m| !m.trim().is_empty()) {
        line.push_str(" - ");
        line.push_str(model);
    }
    line.chars()
        .filter(|c| c.is_ascii_alphanumeric() || " .,:/_+=@-[]{}~#".contains(*c))
        .collect()
}

/// A window title `start` takes as one argument: no quotes inside.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn windows_title(agent_name: &str) -> String {
    terminal_title(agent_name).replace('"', "")
}

/// Quote `value` as one POSIX shell word.
#[cfg_attr(windows, allow(dead_code))]
pub(crate) fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Split off the leading `NAME=value` words of a shell command line (the
/// environment `quotedAgentCommand` puts in front of the program), returning
/// where the program starts. `None` when the line holds anything but one
/// simple command — an operator (`;`, `&`, `|`, a redirection, a subshell) or
/// a newline outside quotes — so it is run as written instead of `exec`ed.
#[cfg_attr(windows, allow(dead_code))]
fn program_start(command: &str) -> Option<usize> {
    let bytes = command.as_bytes();
    let mut i = 0;
    let mut program = None;
    // Inside the current word: (start, whether it is still an assignment).
    let mut word: Option<(usize, bool)> = None;
    while i < bytes.len() {
        let c = bytes[i];
        match c {
            b' ' | b'\t' => {
                if let Some((start, assignment)) = word.take() {
                    if !assignment && program.is_none() {
                        program = Some(start);
                    }
                }
                i += 1;
                continue;
            }
            b';' | b'&' | b'|' | b'<' | b'>' | b'(' | b')' | b'\n' | b'\r' => return None,
            _ => {}
        }
        if word.is_none() {
            // A word is an assignment when it opens with a name and `=`.
            let name_len = bytes[i..]
                .iter()
                .take_while(|b| b.is_ascii_alphanumeric() || **b == b'_')
                .count();
            let assignment = name_len > 0
                && !bytes[i].is_ascii_digit()
                && bytes.get(i + name_len) == Some(&b'=');
            word = Some((i, assignment && program.is_none()));
        }
        match c {
            b'\'' => {
                let close = command[i + 1..].find('\'')?;
                i += close + 2;
            }
            b'"' => {
                let mut j = i + 1;
                loop {
                    match bytes.get(j)? {
                        b'\\' => j += 2,
                        b'"' => break,
                        _ => j += 1,
                    }
                }
                i = j + 1;
            }
            b'\\' => i += 2,
            _ => i += 1,
        }
    }
    if let Some((start, assignment)) = word {
        if !assignment && program.is_none() {
            program = Some(start);
        }
    }
    program
}

/// The line that starts the agent: `exec`ed when it is one simple command,
/// with its environment assignments kept in front (`NAME=value exec agent`
/// exports them to the agent in sh, dash, bash and zsh alike).
#[cfg_attr(windows, allow(dead_code))]
pub(crate) fn exec_line(command: &str) -> String {
    match program_start(command) {
        Some(start) => format!("{}exec {}", &command[..start], &command[start..]),
        None => command.to_string(),
    }
}

/// The POSIX `sh` launcher: it deletes itself, writes its pid to `pid_file`
/// (the agent's, since it `exec`s it), exports `env`, sets the window title,
/// prints `banner`, then runs `command`.
#[cfg_attr(windows, allow(dead_code))]
pub(crate) fn launcher_script(
    command: &str,
    env: &[(String, String)],
    title: Option<&str>,
    banner: Option<&str>,
    pid_file: Option<&Path>,
) -> String {
    let mut script = String::from(
        "#!/bin/sh\n\
         # Written by Atomic Chat to start an agent; it deletes itself first.\n\
         rm -f -- \"$0\"\n",
    );
    if let Some(pid_file) = pid_file {
        script.push_str(&format!(
            "printf '%s' \"$$\" > {}\n",
            sh_quote(&pid_file.to_string_lossy())
        ));
    }
    for (name, value) in env {
        script.push_str(&format!("export {}={}\n", name, sh_quote(value)));
    }
    if let Some(title) = title {
        // A tab an agent was stopped in may still be on its alternate screen,
        // with the cursor hidden: leave both before printing anything.
        script.push_str("printf '\\033[?1049l\\033[?25h\\033[0m'\n");
        script.push_str(&format!(
            "printf '\\033]0;%s\\007' {}\n",
            sh_quote(&one_line(title))
        ));
    }
    if let Some(banner) = banner {
        script.push_str(&format!(
            "printf '%s\\n\\n' {}\n",
            sh_quote(&one_line(banner))
        ));
    }
    script.push_str(&exec_line(command));
    script.push('\n');
    script
}

/// Write `contents` as a fresh 0700 file in `dir`. `create_new` refuses a
/// name that already exists (a planted symlink included).
#[cfg(unix)]
pub(crate) fn write_launcher(
    dir: &Path,
    agent_id: &str,
    contents: &str,
) -> std::io::Result<PathBuf> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let slug: String = agent_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    let path = dir.join(format!(
        "atomic-chat-{}-{}.sh",
        slug,
        uuid::Uuid::new_v4().simple()
    ));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o700)
        .open(&path)?;
    file.write_all(contents.as_bytes())?;
    Ok(path)
}

/// Delete the launcher later in case no terminal ever runs it.
#[cfg(unix)]
fn remove_later(path: PathBuf) {
    std::thread::spawn(move || {
        std::thread::sleep(LAUNCHER_FALLBACK_CLEANUP);
        let _ = std::fs::remove_file(path);
    });
}

/// A fresh, empty 0600 file in `dir` for the launcher to write the agent's
/// pid into. `create_new` refuses a name that already exists, so the file the
/// app later reads is one it made.
#[cfg(unix)]
pub(crate) fn write_pid_file(dir: &Path, agent_id: &str) -> std::io::Result<PathBuf> {
    use std::os::unix::fs::OpenOptionsExt;

    let slug: String = agent_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    let path = dir.join(format!(
        "atomic-chat-{}-{}.pid",
        slug,
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)?;
    Ok(path)
}

/// A launcher written to the temp dir, and the file it writes the agent's pid
/// to when the terminal is for a known agent.
#[cfg(unix)]
pub(crate) struct Launcher {
    pub script: PathBuf,
    pub pid_file: Option<PathBuf>,
}

#[cfg(unix)]
impl Launcher {
    /// The terminal did not open: neither file will be used.
    fn discard(&self) {
        let _ = std::fs::remove_file(&self.script);
        if let Some(pid_file) = &self.pid_file {
            let _ = std::fs::remove_file(pid_file);
        }
    }

    /// The terminal opened: remember the agent's session by its pid file.
    fn track(self, info: Option<&AgentTerminalInfo>) {
        remove_later(self.script);
        if let (Some(info), Some(pid_file)) = (info, self.pid_file) {
            super::agent_sessions::track_pid_file(&info.agent_id, info.model.clone(), pid_file);
        }
    }
}

/// The launcher for `command`, written to the temp dir.
#[cfg(unix)]
fn prepare_launcher(
    command: &str,
    proxy: &[(String, String)],
    info: Option<&AgentTerminalInfo>,
) -> Result<Launcher, String> {
    let dir = std::env::temp_dir();
    let pid_file = match info {
        Some(info) => Some(
            write_pid_file(&dir, &info.agent_id)
                .map_err(|e| format!("Could not write the agent launcher: {}", e))?,
        ),
        None => None,
    };
    let title = info.map(|i| terminal_title(&i.agent_name));
    let banner = info.map(banner_line);
    let contents = launcher_script(
        command,
        proxy,
        title.as_deref(),
        banner.as_deref(),
        pid_file.as_deref(),
    );
    let id = info.map(|i| i.agent_id.as_str()).unwrap_or("agent");
    match write_launcher(&dir, id, &contents) {
        Ok(script) => Ok(Launcher { script, pid_file }),
        Err(e) => {
            if let Some(pid_file) = pid_file {
                let _ = std::fs::remove_file(pid_file);
            }
            Err(format!("Could not write the agent launcher: {}", e))
        }
    }
}

// ---------------------------------------------------------------------------
// macOS: Terminal.app
// ---------------------------------------------------------------------------

/// Opens a tab running `item 1 of argv`, titles it `item 2 of argv`, and
/// answers `<window id>\t<tty>`. Given the tab the agent ran in before
/// (`item 3`, a window id, and `item 4`, its tty) and that tab is idle — the
/// agent exited or was stopped — the launcher runs there instead, so a
/// restarted agent stays in its window. Started cold, Terminal opens a window
/// of its own (or restores the last session's): that one is waited for and
/// reused, instead of racing it with a second window.
#[cfg(any(target_os = "macos", test))]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) const MACOS_OPEN_SCRIPT: &str = r#"on run argv
	set launchLine to item 1 of argv
	set tabTitle to item 2 of argv
	set reuseWindow to 0
	set reuseTty to ""
	if (count of argv) > 3 then
		set reuseWindow to (item 3 of argv) as integer
		set reuseTty to item 4 of argv
	end if
	set wasRunning to application "Terminal" is running
	tell application "Terminal"
		activate
		set newTab to missing value
		if wasRunning and reuseWindow is not 0 then
			repeat with candidate in windows
				if id of candidate is reuseWindow then
					repeat with candidateTab in tabs of candidate
						if (tty of candidateTab is reuseTty) and not (busy of candidateTab) then
							set newTab to contents of candidateTab
							do script launchLine in newTab
							set selected of newTab to true
							set index of candidate to 1
							exit repeat
						end if
					end repeat
					exit repeat
				end if
			end repeat
		end if
		if newTab is not missing value then
			-- The launcher already runs in the agent's old tab.
		else if wasRunning then
			set newTab to do script launchLine
		else
			repeat 30 times
				if exists window 1 then exit repeat
				delay 0.1
			end repeat
			if not (exists window 1) then
				reopen
				repeat 30 times
					if exists window 1 then exit repeat
					delay 0.1
				end repeat
			end if
			if (count of windows) is 1 then
				set newTab to do script launchLine in window 1
			else
				set newTab to do script launchLine
			end if
		end if
		set custom title of newTab to tabTitle
		set title displays custom title of newTab to true
		set tabTty to tty of newTab
		set windowId to 0
		repeat with candidate in windows
			if (tty of tabs of candidate) contains tabTty then
				set windowId to id of candidate
				exit repeat
			end if
		end repeat
	end tell
	return (windowId as text) & (character id 9) & tabTty
end run
"#;

/// Brings forward the tab `item 2 of argv` (a tty) of window `item 1 of argv`
/// when it still runs something, answering "focused"; "gone" otherwise.
/// Never starts Terminal.
#[cfg(any(target_os = "macos", test))]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) const MACOS_FOCUS_SCRIPT: &str = r#"on run argv
	set windowId to (item 1 of argv) as integer
	set tabTty to item 2 of argv
	if application "Terminal" is not running then return "gone"
	tell application "Terminal"
		repeat with candidate in windows
			if id of candidate is windowId then
				repeat with candidateTab in tabs of candidate
					if (tty of candidateTab is tabTty) and (busy of candidateTab) then
						set selected of candidateTab to true
						set index of candidate to 1
						activate
						return "focused"
					end if
				end repeat
			end if
		end repeat
	end tell
	return "gone"
end run
"#;

/// The Terminal tab an agent was started in.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TerminalTab {
    pub window_id: i64,
    pub tty: String,
}

/// `<window id>\t<tty>` from [`MACOS_OPEN_SCRIPT`].
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn parse_terminal_tab(answer: &str) -> Option<TerminalTab> {
    let (window, tty) = answer.trim().split_once('\t')?;
    let window_id = window.trim().parse::<i64>().ok().filter(|id| *id > 0)?;
    let tty = tty.trim();
    tty.starts_with("/dev/").then(|| TerminalTab {
        window_id,
        tty: tty.to_string(),
    })
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::collections::HashMap;
    use std::io::Write;
    use std::process::{Command, Stdio};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};

    /// Long enough for the user to answer the first-run Automation prompt,
    /// which `osascript` waits on.
    const OSASCRIPT_TIMEOUT: Duration = Duration::from_secs(90);

    fn tabs() -> &'static Mutex<HashMap<String, TerminalTab>> {
        static TABS: OnceLock<Mutex<HashMap<String, TerminalTab>>> = OnceLock::new();
        TABS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    /// Run an AppleScript with `args`, answering its result; its error text
    /// (or exit status) otherwise.
    fn osascript(script: &str, args: &[&str], timeout: Duration) -> Result<String, String> {
        let mut child = Command::new("/usr/bin/osascript")
            .arg("-")
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to run osascript: {}", e))?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(script.as_bytes())
                .map_err(|e| format!("Failed to run osascript: {}", e))?;
        }
        let deadline = Instant::now() + timeout;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(50))
                }
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("Terminal did not answer in time".to_string());
                }
                Err(e) => return Err(format!("Failed to wait for osascript: {}", e)),
            }
        }
        let output = child
            .wait_with_output()
            .map_err(|e| format!("Failed to read osascript: {}", e))?;
        if output.status.success() {
            return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
        }
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("osascript exited with {}", output.status)
        } else {
            stderr
        })
    }

    /// Bring forward the tab `agent_id` was started in, when it still runs.
    /// The tab is remembered either way: once idle, the next open runs there.
    fn focus(agent_id: &str) -> bool {
        let Some(tab) = tabs().lock().ok().and_then(|t| t.get(agent_id).cloned()) else {
            return false;
        };
        let window = tab.window_id.to_string();
        matches!(
            osascript(
                MACOS_FOCUS_SCRIPT,
                &[&window, &tab.tty],
                Duration::from_secs(10),
            ),
            Ok(answer) if answer == "focused"
        )
    }

    pub(crate) fn open(
        command: &str,
        proxy: &[(String, String)],
        info: Option<&AgentTerminalInfo>,
    ) -> Result<TerminalOutcome, String> {
        if let Some(info) = info {
            if focus(&info.agent_id) {
                log::info!("Brought the {} terminal forward", info.agent_id);
                return Ok(TerminalOutcome::Focused);
            }
        }
        let launcher = prepare_launcher(command, proxy, info)?;
        // The leading space keeps the line out of history where the shell
        // ignores space-prefixed commands; only the path is typed anyway.
        let launch_line = format!(" {}", sh_quote(&launcher.script.to_string_lossy()));
        let title = info
            .map(|i| terminal_title(&i.agent_name))
            .unwrap_or_else(|| "Atomic Chat".to_string());
        let previous = info.and_then(|i| tabs().lock().ok()?.get(&i.agent_id).cloned());
        let mut args = vec![launch_line, title];
        if let Some(tab) = previous {
            args.push(tab.window_id.to_string());
            args.push(tab.tty);
        }
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        match osascript(MACOS_OPEN_SCRIPT, &args, OSASCRIPT_TIMEOUT) {
            Ok(answer) => {
                launcher.track(info);
                match (info, parse_terminal_tab(&answer)) {
                    (Some(info), Some(tab)) => {
                        if let Ok(mut t) = tabs().lock() {
                            t.insert(info.agent_id.clone(), tab);
                        }
                    }
                    (_, None) => {
                        log::warn!("Terminal opened, but its tab is unknown: {:?}", answer)
                    }
                    _ => {}
                }
                // Not the command: it may carry a key.
                log::info!(
                    "Opened Terminal for {}",
                    info.map(|i| i.agent_id.as_str()).unwrap_or("an agent")
                );
                Ok(TerminalOutcome::Opened)
            }
            Err(error) => {
                launcher.discard();
                log::warn!("Terminal did not open: {}", error);
                Err(format!("Terminal did not open: {}", error))
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub(crate) use macos::open as open_macos;

// ---------------------------------------------------------------------------
// Linux and the other Unixes: the user's terminal emulator
// ---------------------------------------------------------------------------

/// A terminal emulator and the arguments that come before the program it
/// should run.
#[cfg_attr(any(windows, target_os = "macos"), allow(dead_code))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TerminalCandidate {
    pub program: String,
    pub prefix: Vec<String>,
}

/// The emulators tried after `$TERMINAL`, in order: the freedesktop launcher,
/// then the defaults of GNOME (Ptyxis on Fedora 41+ and Ubuntu 25.10+, Console,
/// GNOME Terminal), KDE and Xfce, the popular standalone ones, Debian's
/// alternative, and xterm.
#[cfg_attr(any(windows, target_os = "macos"), allow(dead_code))]
const LINUX_TERMINALS: &[(&str, &[&str])] = &[
    ("xdg-terminal-exec", &[]),
    ("ptyxis", &["--"]),
    ("kgx", &["--"]),
    ("gnome-terminal", &["--"]),
    ("konsole", &["-e"]),
    // `-e` takes one string; `-x` takes the rest of the line as the command.
    ("xfce4-terminal", &["-x"]),
    ("kitty", &[]),
    ("alacritty", &["-e"]),
    ("wezterm", &["start", "--"]),
    ("foot", &[]),
    ("x-terminal-emulator", &["-e"]),
    ("xterm", &["-e"]),
];

/// The emulators to try: `$TERMINAL` first (with the arguments its name is
/// known to take, `-e` otherwise), then [`LINUX_TERMINALS`].
#[cfg_attr(any(windows, target_os = "macos"), allow(dead_code))]
pub(crate) fn linux_terminal_candidates(terminal_env: Option<&str>) -> Vec<TerminalCandidate> {
    let known = |name: &str| {
        LINUX_TERMINALS
            .iter()
            .find(|(program, _)| *program == name)
            .map(|(_, prefix)| prefix.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    };
    let mut candidates = Vec::new();
    if let Some(terminal) = terminal_env.map(str::trim).filter(|t| !t.is_empty()) {
        let name = Path::new(terminal)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(terminal);
        candidates.push(TerminalCandidate {
            program: terminal.to_string(),
            prefix: known(name).unwrap_or_else(|| vec!["-e".to_string()]),
        });
    }
    for (program, prefix) in LINUX_TERMINALS {
        if candidates.iter().any(|c| c.program == *program) {
            continue;
        }
        candidates.push(TerminalCandidate {
            program: program.to_string(),
            prefix: prefix.iter().map(|s| s.to_string()).collect(),
        });
    }
    candidates
}

/// The emulator's arguments: run `launcher` in the user's interactive login
/// shell (its rc files set PATH up), then stay in that shell once the agent
/// exits so the window does not vanish with its output.
#[cfg_attr(any(windows, target_os = "macos"), allow(dead_code))]
pub(crate) fn linux_terminal_args(
    candidate: &TerminalCandidate,
    shell: &str,
    launcher: &Path,
) -> Vec<String> {
    let inner = format!(
        "{}; exec {}",
        sh_quote(&launcher.to_string_lossy()),
        sh_quote(shell)
    );
    let mut args = candidate.prefix.clone();
    args.extend([
        shell.to_string(),
        "-l".to_string(),
        "-i".to_string(),
        "-c".to_string(),
        inner,
    ]);
    args
}

/// The user's shell: `$SHELL`, else the first of bash and sh that exists.
#[cfg(all(unix, not(target_os = "macos")))]
fn user_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            ["/bin/bash", "/bin/sh"]
                .iter()
                .find(|p| Path::new(p).exists())
                .map(|p| p.to_string())
        })
        .unwrap_or_else(|| "/bin/sh".to_string())
}

/// Spawn `cmd` and give it a moment: one that exits at once with an error did
/// not open a window (its stderr says why). One that exits cleanly handed the
/// window to a server (gnome-terminal does); one still running is the window.
#[cfg(all(unix, not(target_os = "macos")))]
fn spawn_terminal(mut cmd: std::process::Command) -> Result<(), String> {
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    const GRACE: Duration = Duration::from_millis(600);

    let err_path = std::env::temp_dir().join(format!(
        "atomic-chat-terminal-{}.err",
        uuid::Uuid::new_v4().simple()
    ));
    let err_file = std::fs::File::create(&err_path).map_err(|e| e.to_string())?;
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(err_file);
    let spawned = cmd.spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(e) => {
            let _ = std::fs::remove_file(&err_path);
            return Err(e.to_string());
        }
    };
    let deadline = Instant::now() + GRACE;
    let result = loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break Ok(()),
            Ok(Some(status)) => {
                let stderr = std::fs::read_to_string(&err_path).unwrap_or_default();
                let stderr = stderr.trim();
                break Err(if stderr.is_empty() {
                    format!("exited with {}", status)
                } else {
                    stderr.lines().last().unwrap_or(stderr).to_string()
                });
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                // Reap it when the window closes.
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                break Ok(());
            }
            Err(e) => break Err(e.to_string()),
        }
    };
    let _ = std::fs::remove_file(&err_path);
    result
}

/// Open the first emulator that works. `prepare` gives each one the
/// environment it needs to be found and to start (PATH, no AppImage leftovers).
#[cfg(all(unix, not(target_os = "macos")))]
pub(crate) fn open_linux(
    command: &str,
    proxy: &[(String, String)],
    info: Option<&AgentTerminalInfo>,
    prepare: &dyn Fn(&mut std::process::Command),
) -> Result<TerminalOutcome, String> {
    let launcher = prepare_launcher(command, proxy, info)?;
    let shell = user_shell();
    let terminal_env = std::env::var("TERMINAL").ok();
    let mut failures = Vec::new();
    for candidate in linux_terminal_candidates(terminal_env.as_deref()) {
        let mut cmd = std::process::Command::new(&candidate.program);
        cmd.args(linux_terminal_args(&candidate, &shell, &launcher.script));
        prepare(&mut cmd);
        match spawn_terminal(cmd) {
            Ok(()) => {
                launcher.track(info);
                // Not the command: it may carry a key.
                log::info!(
                    "Opened {} for {}",
                    candidate.program,
                    info.map(|i| i.agent_id.as_str()).unwrap_or("an agent")
                );
                return Ok(TerminalOutcome::Opened);
            }
            Err(error) => {
                if !error.contains("No such file or directory") {
                    failures.push(format!("{}: {}", candidate.program, error));
                }
            }
        }
    }
    launcher.discard();
    Err(if failures.is_empty() {
        "No supported terminal emulator found".to_string()
    } else {
        format!("No terminal emulator opened ({})", failures.join("; "))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(model: Option<&str>) -> AgentTerminalInfo {
        AgentTerminalInfo {
            agent_id: "claude-code".to_string(),
            agent_name: "Claude Code".to_string(),
            endpoint: "http://127.0.0.1:1337".to_string(),
            model: model.map(str::to_string),
        }
    }

    #[test]
    fn title_and_banner_name_the_agent_endpoint_and_model() {
        assert_eq!(
            terminal_title("Claude Code"),
            "Atomic Chat \u{2013} Claude Code"
        );
        assert_eq!(
            banner_line(&info(Some("qwen3.5-9b"))),
            "Atomic Chat \u{b7} Claude Code \u{2192} http://127.0.0.1:1337 \u{b7} qwen3.5-9b"
        );
        assert_eq!(
            banner_line(&info(None)),
            "Atomic Chat \u{b7} Claude Code \u{2192} http://127.0.0.1:1337"
        );
    }

    #[test]
    fn a_model_id_cannot_inject_terminal_escapes() {
        let banner = banner_line(&info(Some("evil\u{1b}]0;pwned\u{7}\nrm -rf")));
        assert!(!banner.chars().any(char::is_control), "{banner:?}");
    }

    #[test]
    fn windows_banner_keeps_only_what_echo_prints_verbatim() {
        let line = windows_echo_line(&info(Some("org/model & %PATH% |x| ^!\"")));
        assert_eq!(
            line,
            "Atomic Chat - Claude Code - http://127.0.0.1:1337 - org/model  PATH x "
        );
        assert_eq!(windows_title("Say \"hi\""), "Atomic Chat \u{2013} Say hi");
    }

    #[test]
    fn exec_keeps_the_environment_in_front_of_the_program() {
        assert_eq!(
            exec_line("ATOMIC_CHAT_API_KEY='it'\\''s' 'codex' '--profile' 'atomic-chat'"),
            "ATOMIC_CHAT_API_KEY='it'\\''s' exec 'codex' '--profile' 'atomic-chat'"
        );
        assert_eq!(exec_line("claude"), "exec claude");
        assert_eq!(exec_line("openclaw chat"), "exec openclaw chat");
        assert_eq!(
            exec_line("A=1 B=\"two words\" '/opt/my agent/bin' x"),
            "A=1 B=\"two words\" exec '/opt/my agent/bin' x"
        );
        // An `=` past the program is an argument, not an assignment.
        assert_eq!(exec_line("tool --flag=a"), "exec tool --flag=a");
        assert_eq!(exec_line("'/a=b/agent'"), "exec '/a=b/agent'");
    }

    #[test]
    fn a_compound_command_runs_as_written() {
        for command in [
            "cd /tmp && agent",
            "agent; exec $SHELL",
            "agent | tee log",
            "agent > out",
            "(agent)",
            "A=1",
        ] {
            assert_eq!(exec_line(command), command, "{command}");
        }
        // Operators inside quotes are data.
        assert_eq!(exec_line("K='a;b|c' agent"), "K='a;b|c' exec agent");
        // Unbalanced quotes are left to the shell to report.
        assert_eq!(exec_line("agent 'oops"), "agent 'oops");
    }

    #[test]
    fn the_launcher_deletes_itself_exports_and_execs() {
        let script = launcher_script(
            "KEY='s3cret' 'codex'",
            &[(
                "HTTPS_PROXY".to_string(),
                "http://u:p'w@proxy:8080".to_string(),
            )],
            Some("Atomic Chat \u{2013} Codex CLI"),
            Some("Atomic Chat \u{b7} Codex CLI"),
            Some(Path::new("/tmp/atomic chat's/codex.pid")),
        );
        let lines: Vec<&str> = script.lines().collect();
        assert_eq!(lines[0], "#!/bin/sh");
        assert_eq!(lines[2], "rm -f -- \"$0\"");
        assert_eq!(
            lines[3],
            "printf '%s' \"$$\" > '/tmp/atomic chat'\\''s/codex.pid'"
        );
        assert!(lines.contains(&"printf '\\033[?1049l\\033[?25h\\033[0m'"));
        assert!(lines.contains(&"export HTTPS_PROXY='http://u:p'\\''w@proxy:8080'"));
        assert!(lines.contains(&"printf '\\033]0;%s\\007' 'Atomic Chat \u{2013} Codex CLI'"));
        assert!(lines.contains(&"printf '%s\\n\\n' 'Atomic Chat \u{b7} Codex CLI'"));
        assert_eq!(*lines.last().unwrap(), "KEY='s3cret' exec 'codex'");
    }

    #[cfg(unix)]
    #[test]
    fn the_launcher_runs_in_sh_with_its_environment_and_removes_itself() {
        let dir = tempfile::tempdir().unwrap();
        let script = launcher_script(
            "KEY='it'\\''s $HOME' /usr/bin/env",
            &[("HTTP_PROXY".to_string(), "http://proxy:1".to_string())],
            None,
            Some("banner"),
            None,
        );
        let path = write_launcher(dir.path(), "co/dex", &script).unwrap();
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert!(path
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("atomic-chat-codex-"));

        let output = std::process::Command::new(&path).output().unwrap();
        let stdout = String::from_utf8(output.stdout).unwrap();
        assert!(output.status.success());
        assert!(stdout.starts_with("banner\n\n"), "{stdout}");
        assert!(stdout.lines().any(|l| l == "KEY=it's $HOME"), "{stdout}");
        assert!(
            stdout.lines().any(|l| l == "HTTP_PROXY=http://proxy:1"),
            "{stdout}"
        );
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn the_pid_the_launcher_writes_is_the_agents() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = write_pid_file(dir.path(), "claude-code").unwrap();
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&pid_file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(write_pid_file(dir.path(), "claude-code").unwrap() != pid_file);
        // The agent here prints its own pid: `exec` kept the launcher's.
        let script = launcher_script("/bin/sh -c 'echo $$'", &[], None, None, Some(&pid_file));
        let path = write_launcher(dir.path(), "claude-code", &script).unwrap();
        let output = std::process::Command::new(&path).output().unwrap();
        assert!(output.status.success());
        let printed = String::from_utf8(output.stdout).unwrap();
        assert_eq!(std::fs::read_to_string(&pid_file).unwrap(), printed.trim());
    }

    #[cfg(unix)]
    #[test]
    fn an_existing_launcher_name_is_never_reused() {
        let dir = tempfile::tempdir().unwrap();
        let first = write_launcher(dir.path(), "pi", "a").unwrap();
        let second = write_launcher(dir.path(), "pi", "b").unwrap();
        assert_ne!(first, second);
        assert_eq!(std::fs::read_to_string(first).unwrap(), "a");
    }

    #[test]
    fn terminal_tab_answer_is_parsed() {
        assert_eq!(
            parse_terminal_tab("4711\t/dev/ttys004\n"),
            Some(TerminalTab {
                window_id: 4711,
                tty: "/dev/ttys004".to_string()
            })
        );
        assert_eq!(parse_terminal_tab("0\t/dev/ttys004"), None);
        assert_eq!(parse_terminal_tab("4711"), None);
        assert_eq!(parse_terminal_tab("4711\tmissing value"), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_terminal_scripts_compile() {
        // `osacompile` checks the scripts against Terminal's dictionary
        // without starting Terminal or sending it anything.
        let dir = tempfile::tempdir().unwrap();
        for (name, script) in [("open", MACOS_OPEN_SCRIPT), ("focus", MACOS_FOCUS_SCRIPT)] {
            let source = dir.path().join(format!("{name}.applescript"));
            std::fs::write(&source, script).unwrap();
            let output = std::process::Command::new("/usr/bin/osacompile")
                .arg("-o")
                .arg(dir.path().join(format!("{name}.scpt")))
                .arg(&source)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{name}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }

    #[test]
    fn terminal_env_comes_first_then_the_known_emulators() {
        let names =
            |c: &[TerminalCandidate]| c.iter().map(|c| c.program.clone()).collect::<Vec<_>>();
        let plain = linux_terminal_candidates(None);
        assert_eq!(
            names(&plain),
            [
                "xdg-terminal-exec",
                "ptyxis",
                "kgx",
                "gnome-terminal",
                "konsole",
                "xfce4-terminal",
                "kitty",
                "alacritty",
                "wezterm",
                "foot",
                "x-terminal-emulator",
                "xterm"
            ]
        );
        let xfce = plain
            .iter()
            .find(|c| c.program == "xfce4-terminal")
            .unwrap();
        assert_eq!(xfce.prefix, ["-x"]);

        let custom = linux_terminal_candidates(Some("/usr/local/bin/my-term"));
        assert_eq!(custom[0].program, "/usr/local/bin/my-term");
        assert_eq!(custom[0].prefix, ["-e"]);
        assert_eq!(custom.len(), plain.len() + 1);

        // A known emulator named by $TERMINAL takes its own arguments, once.
        let kitty = linux_terminal_candidates(Some("kitty"));
        assert_eq!(
            kitty[0],
            TerminalCandidate {
                program: "kitty".into(),
                prefix: vec![]
            }
        );
        assert_eq!(kitty.iter().filter(|c| c.program == "kitty").count(), 1);
        let wezterm = linux_terminal_candidates(Some("/usr/bin/wezterm"));
        assert_eq!(wezterm[0].prefix, ["start", "--"]);
    }

    #[test]
    fn the_emulator_runs_the_launcher_in_the_users_login_shell() {
        let gnome = TerminalCandidate {
            program: "gnome-terminal".into(),
            prefix: vec!["--".into()],
        };
        assert_eq!(
            linux_terminal_args(&gnome, "/usr/bin/fish", Path::new("/tmp/atomic chat.sh")),
            [
                "--",
                "/usr/bin/fish",
                "-l",
                "-i",
                "-c",
                "'/tmp/atomic chat.sh'; exec '/usr/bin/fish'"
            ]
        );
    }
}
