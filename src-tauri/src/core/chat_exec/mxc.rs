//! Microsoft MXC (`wxc-exec.exe`, contract 1.0.0) around chat commands on
//! Windows.
//!
//! Only the built-in process isolation (the "base-container" tier) is used:
//! it needs no administrator and changes no folder permissions. The AppContainer
//! fallback that rewrites ACLs is refused (`allowDaclMutation: false`), so a
//! machine without a recent enough Windows 11 runs chat commands on the host —
//! with an approval that says so — instead of being prepared as admin.
//!
//! The policy builder, quoting and output parsing are plain functions so they
//! are tested on every OS; only `probe` launches anything.

#![cfg_attr(not(windows), allow(dead_code))]

use std::path::{Path, PathBuf};

use base64::Engine;
use serde_json::{json, Value};

use super::runner::Launch;

pub(crate) const CONTRACT_VERSION: &str = "1.0.0";
/// Where the Windows bundle puts the executor (`tauri.windows.conf.json`).
pub(crate) const WXC_EXEC_RESOURCE: &str = "resources/bin/mxc/wxc-exec.exe";
/// `--config-base64` rides the command line, which Windows caps at 32 767
/// characters; leave room for the executable's own path.
pub(crate) const MAX_CONFIG_BASE64: usize = 30_000;
/// MXC enforces the call's timeout itself; the host waits this much longer
/// before it kills the executor.
pub(crate) const HOST_TIMEOUT_GRACE_SECS: u64 = 15;

pub(crate) struct PolicyInput<'a> {
    pub container_id: &'a str,
    pub command_line: &'a str,
    pub workdir: &'a Path,
    /// The user's Desktop, Documents and Downloads: writable like the chat
    /// folder, so "put it on my desktop" works on every OS.
    pub user_folders: &'a [PathBuf],
    pub env: &'a [(String, String)],
    pub readonly_paths: &'a [PathBuf],
    pub timeout_ms: u64,
}

/// The MXC request for one call: the chat folder and the user's Desktop,
/// Documents and Downloads are the only writable places, the runtime folders
/// are read-only, everything else (AppData, `.ssh`, the rest of the profile,
/// the system) stays out of reach. The network is open (the user approved the
/// call; `pip install` and `curl` are what commands are for), and nothing can
/// reach the clipboard or other windows.
pub(crate) fn build_policy(input: &PolicyInput<'_>) -> Value {
    let writable = writable_roots(input.workdir, input.user_folders);
    json!({
        "version": CONTRACT_VERSION,
        "containerId": input.container_id,
        "containment": "processcontainer",
        "lifecycle": { "destroyOnExit": true, "preservePolicy": false },
        "process": {
            "commandLine": input.command_line,
            "cwd": path_text(input.workdir),
            "env": input
                .env
                .iter()
                .map(|(key, value)| format!("{key}={value}"))
                .collect::<Vec<_>>(),
            "inheritDefaultEnv": false,
            "timeout": input.timeout_ms,
        },
        "filesystem": {
            "readwritePaths": writable.iter().map(|path| path_text(path)).collect::<Vec<_>>(),
            "readonlyPaths": readonly_roots(input.readonly_paths, &writable),
            "deniedPaths": [],
        },
        "fallback": { "allowDaclMutation": false },
        "network": {
            "egress": { "default": "allow" },
            "ingress": { "default": "deny" },
        },
        // Console programs still load user32; a disabled UI breaks them. The
        // limited UI keeps the clipboard and input injection closed.
        "ui": { "disable": false, "clipboard": "none", "injection": false },
        "processContainer": {
            "leastPrivilege": false,
            "capabilities": ["internetClient"],
        },
    })
}

/// The chat folder first, then each user folder that is not already inside
/// it or another; never a drive root.
fn writable_roots<'a>(workdir: &'a Path, user_folders: &'a [PathBuf]) -> Vec<&'a Path> {
    let mut roots = vec![workdir];
    for folder in user_folders {
        let folder = folder.as_path();
        if folder.parent().is_none() || roots.iter().any(|root| folder.starts_with(root)) {
            continue;
        }
        roots.retain(|root| *root == workdir || !root.starts_with(folder));
        roots.push(folder);
    }
    roots
}

/// Existing, de-duplicated folders, none nested in another or in a writable
/// folder (which already grants more).
fn readonly_roots(paths: &[PathBuf], writable: &[&Path]) -> Vec<String> {
    let mut roots: Vec<&PathBuf> = Vec::new();
    for path in paths {
        if path.parent().is_none() || writable.iter().any(|root| path.starts_with(root)) {
            continue;
        }
        if roots.iter().any(|root| path.starts_with(root)) {
            continue;
        }
        roots.retain(|root| !root.starts_with(path));
        roots.push(path);
    }
    roots.into_iter().map(|path| path_text(path)).collect()
}

fn path_text(path: &Path) -> String {
    path.display().to_string()
}

pub(crate) fn encode_policy(policy: &Value) -> Result<String, String> {
    let bytes = serde_json::to_vec(policy).map_err(|error| error.to_string())?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    if encoded.len() > MAX_CONFIG_BASE64 {
        return Err(
            "This command is too long to run in the Windows sandbox. Put it in a script with run_script instead."
                .into(),
        );
    }
    Ok(encoded)
}

/// How `wxc-exec.exe` itself is started: a minimal environment (the workload
/// gets its own from the policy) and the policy as base64.
pub(crate) fn executor_launch(wxc_exec: &Path, encoded_policy: String) -> Launch {
    const CONTROL_ENV: [&str; 6] = ["SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP", "PROGRAMDATA"];
    let env = std::env::vars()
        .filter(|(key, _)| {
            CONTROL_ENV
                .iter()
                .any(|name| key.eq_ignore_ascii_case(name))
        })
        .collect();
    Launch {
        program: wxc_exec.display().to_string(),
        args: vec!["--config-base64".into(), encoded_policy],
        raw_args: None,
        cwd: wxc_exec
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(std::env::temp_dir),
        env,
        clear_env: true,
    }
}

/// One argument as the Microsoft C runtime parses it back.
pub(crate) fn quote_windows_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '\u{0b}', '"']) {
        return arg.to_owned();
    }
    let mut quoted = String::from('"');
    let mut backslashes = 0;
    for ch in arg.chars() {
        match ch {
            '\\' => backslashes += 1,
            '"' => {
                quoted.push_str(&"\\".repeat(backslashes * 2 + 1));
                quoted.push('"');
                backslashes = 0;
            }
            _ => {
                quoted.push_str(&"\\".repeat(backslashes));
                quoted.push(ch);
                backslashes = 0;
            }
        }
    }
    quoted.push_str(&"\\".repeat(backslashes * 2));
    quoted.push('"');
    quoted
}

pub(crate) fn windows_command_line(program: &str, args: &[String]) -> String {
    std::iter::once(program)
        .chain(args.iter().map(String::as_str))
        .map(quote_windows_arg)
        .collect::<Vec<_>>()
        .join(" ")
}

/// `cmd.exe` takes the rest of its command line verbatim after `/s /c "…"`;
/// MSVCRT-style escaping would reach the command as literal backslashes.
pub(crate) fn cmd_arguments(command: &str) -> String {
    format!("/d /s /c \"{command}\"")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MxcError {
    pub code: String,
    pub message: String,
}

/// MXC reports its own failures as one JSON line on stderr:
/// `{"error":{"code":"policy_validation","message":"…"}}`.
pub(crate) fn parse_error(stderr: &str) -> Option<MxcError> {
    let line = stderr.lines().rev().find(|line| !line.trim().is_empty())?;
    let value: Value = serde_json::from_str(line.trim()).ok()?;
    let error = value.get("error")?;
    Some(MxcError {
        code: error.get("code")?.as_str()?.to_owned(),
        message: error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
    })
}

fn normalized(code: &str) -> String {
    code.chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .map(|ch| ch.to_ascii_lowercase())
        .collect()
}

/// Codes that mean the workload never started. The workload can print the
/// same line, so this only ever prompts a fresh probe — never a host re-run.
pub(crate) fn is_pre_launch(error: &MxcError) -> bool {
    matches!(
        normalized(&error.code).as_str(),
        "policyvalidation" | "malformedrequest" | "unsupportedcontainment" | "backendunavailable"
    )
}

pub(crate) fn is_timeout(error: &MxcError) -> bool {
    normalized(&error.code).contains("timeout") || normalized(&error.code).contains("timedout")
}

/// `wxc-exec --probe` prints which isolation tier this machine would get.
/// Only the base container qualifies.
pub(crate) fn check_probe_output(stdout: &str) -> Result<(), String> {
    let value: Value = serde_json::from_str(stdout.trim())
        .map_err(|_| "The Windows sandbox probe returned no readable answer".to_owned())?;
    let tier = value
        .get("tier")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if normalized(tier) == "basecontainer" {
        return Ok(());
    }
    let warning = value
        .get("warnings")
        .and_then(Value::as_array)
        .and_then(|warnings| warnings.iter().find_map(Value::as_str))
        .map(|warning| format!(" ({warning})"))
        .unwrap_or_default();
    Err(if tier.is_empty() {
        format!("This Windows has no built-in process isolation{warning}. It needs Windows 11 24H2 with the August 2026 update or later.")
    } else {
        format!("This Windows only offers the '{tier}' sandbox tier, which needs administrator setup{warning}. Built-in isolation needs Windows 11 24H2 with the August 2026 update or later.")
    })
}

/// Probe the executor, then prove it: a run must write inside its folder and
/// fail to read a file next to it.
#[cfg(windows)]
pub(crate) async fn probe(wxc_exec: &Path, scratch: &Path) -> Result<(), String> {
    use std::time::Duration;
    use tokio_util::sync::CancellationToken;

    let mut command = tokio::process::Command::new(wxc_exec);
    command
        .arg("--probe")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .creation_flags(0x0800_0000);
    let output = tokio::time::timeout(Duration::from_secs(30), command.output())
        .await
        .map_err(|_| "The Windows sandbox probe did not answer in time".to_owned())?
        .map_err(|error| format!("Could not start the Windows sandbox: {error}"))?;
    check_probe_output(&String::from_utf8_lossy(&output.stdout))?;

    let run_root = scratch.join(format!("mxc-probe-{}", uuid::Uuid::new_v4().simple()));
    let workdir = run_root.join("work");
    std::fs::create_dir_all(&workdir).map_err(|error| error.to_string())?;
    let canary = run_root.join("outside.txt");
    std::fs::write(&canary, "outside").map_err(|error| error.to_string())?;
    let result = async {
        let system_root = system_root();
        let cmd = system_root.join("System32").join("cmd.exe");
        let script = format!(
            "echo inside>inside.txt && (type \"{}\" >nul 2>&1 && echo ATOMIC-LEAK || echo ATOMIC-DENIED)",
            canary.display()
        );
        let command_line = format!("{} {}", quote_windows_arg(&cmd.display().to_string()), cmd_arguments(&script));
        let env = workload_base_env(&workdir, &[]);
        let container_id = format!("atomic-probe-{}", uuid::Uuid::new_v4().simple());
        let policy = build_policy(&PolicyInput {
            container_id: &container_id,
            command_line: &command_line,
            workdir: &workdir,
            user_folders: &[],
            env: &env,
            readonly_paths: &[system_root],
            timeout_ms: 20_000,
        });
        let launch = executor_launch(wxc_exec, encode_policy(&policy)?);
        let output = super::runner::run(&launch, Duration::from_secs(35), &CancellationToken::new()).await?;
        if let Some(error) = parse_error(&output.stderr) {
            return Err(format!("The Windows sandbox refused a test run: {} ({})", error.message, error.code));
        }
        let wrote_inside = workdir.join("inside.txt").is_file();
        if output.exit_code != Some(0) || !wrote_inside || !output.stdout.contains("ATOMIC-DENIED") {
            return Err("The Windows sandbox test run did not behave as isolated".into());
        }
        Ok(())
    }
    .await;
    let _ = std::fs::remove_dir_all(&run_root);
    result
}

pub(crate) fn system_root() -> PathBuf {
    std::env::var_os("SYSTEMROOT")
        .or_else(|| std::env::var_os("WINDIR"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
}

/// The variables every program under MXC needs (MXC refuses an environment
/// without `SYSTEMROOT` and `LOCALAPPDATA`), with the chat folder standing in
/// for the user's profile folders. `path_dirs` go first on PATH.
pub(crate) fn workload_base_env(workdir: &Path, path_dirs: &[PathBuf]) -> Vec<(String, String)> {
    let system_root = system_root();
    let system32 = system_root.join("System32");
    let mut path: Vec<PathBuf> = path_dirs.to_vec();
    path.extend([
        system32.clone(),
        system_root.clone(),
        system32.join("Wbem"),
        system32.join(r"WindowsPowerShell\v1.0"),
    ]);
    // Joined by hand: this is a Windows PATH even where the tests run.
    let path = path
        .iter()
        .map(|dir| dir.display().to_string())
        .collect::<Vec<_>>()
        .join(";");
    let workdir_text = workdir.display().to_string();
    let (home_drive, home_path) = split_drive(&workdir_text);
    let mut env = vec![
        ("SYSTEMROOT".to_owned(), system_root.display().to_string()),
        ("WINDIR".to_owned(), system_root.display().to_string()),
        (
            "COMSPEC".to_owned(),
            system32.join("cmd.exe").display().to_string(),
        ),
        ("PATH".to_owned(), path),
        ("PATHEXT".to_owned(), ".COM;.EXE;.BAT;.CMD;.PS1".to_owned()),
        ("LOCALAPPDATA".to_owned(), workdir_text.clone()),
        ("APPDATA".to_owned(), workdir_text.clone()),
        ("HOMEDRIVE".to_owned(), home_drive),
        ("HOMEPATH".to_owned(), home_path),
    ];
    for name in [
        "SystemDrive",
        "NUMBER_OF_PROCESSORS",
        "PROCESSOR_ARCHITECTURE",
        "PROCESSOR_IDENTIFIER",
        "OS",
    ] {
        if let Ok(value) = std::env::var(name) {
            env.push((name.to_owned(), value));
        }
    }
    env
}

/// `C:\data\chat` → (`C:`, `\data\chat`), how Windows spells a home folder.
fn split_drive(path: &str) -> (String, String) {
    let bytes = path.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        let rest = &path[2..];
        return (
            path[..2].to_owned(),
            if rest.is_empty() {
                "\\".to_owned()
            } else {
                rest.to_owned()
            },
        );
    }
    (String::new(), path.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> Value {
        build_policy(&PolicyInput {
            container_id: "atomic-1",
            command_line: r#""C:\Windows\System32\cmd.exe" /d /s /c "dir""#,
            workdir: Path::new(r"C:\data\chat\t1"),
            user_folders: &[],
            env: &[("SYSTEMROOT".into(), r"C:\Windows".into())],
            readonly_paths: &[PathBuf::from(r"C:\Windows")],
            timeout_ms: 120_000,
        })
    }

    #[test]
    fn asks_for_the_1_0_process_container_with_only_the_chat_folder_writable() {
        let policy = policy();

        assert_eq!(policy["version"], "1.0.0");
        assert_eq!(policy["containment"], "processcontainer");
        assert_eq!(
            policy["filesystem"]["readwritePaths"],
            json!([r"C:\data\chat\t1"])
        );
        assert_eq!(policy["process"]["cwd"], r"C:\data\chat\t1");
        assert_eq!(policy["process"]["inheritDefaultEnv"], false);
        assert_eq!(policy["process"]["timeout"], 120_000);
        assert_eq!(policy["process"]["env"], json!([r"SYSTEMROOT=C:\Windows"]));
        assert_eq!(policy["lifecycle"]["destroyOnExit"], true);
    }

    #[test]
    fn never_lets_mxc_rewrite_folder_permissions() {
        assert_eq!(policy()["fallback"], json!({ "allowDaclMutation": false }));
    }

    #[test]
    fn keeps_the_clipboard_and_input_injection_closed() {
        let policy = policy();
        assert_eq!(policy["ui"]["clipboard"], "none");
        assert_eq!(policy["ui"]["injection"], false);
        assert_eq!(policy["network"]["ingress"]["default"], "deny");
    }

    #[test]
    fn lets_the_user_folders_be_written_beside_the_chat_folder() {
        let base = std::env::temp_dir();
        let chat = base.join("chat");
        let policy = build_policy(&PolicyInput {
            container_id: "atomic-1",
            command_line: "cmd",
            workdir: &chat,
            user_folders: &[
                base.join("Desktop"),
                base.join("Documents"),
                chat.join("inner"),
            ],
            env: &[],
            readonly_paths: &[base.join("Documents").join("tools"), base.join("py")],
            timeout_ms: 1,
        });

        assert_eq!(
            policy["filesystem"]["readwritePaths"],
            json!([
                chat.display().to_string(),
                base.join("Desktop").display().to_string(),
                base.join("Documents").display().to_string(),
            ])
        );
        // A runtime folder inside a writable one needs no read-only grant.
        assert_eq!(
            policy["filesystem"]["readonlyPaths"],
            json!([base.join("py").display().to_string()])
        );
    }

    #[test]
    fn grants_each_read_only_root_once() {
        let base = std::env::temp_dir();
        let roots = readonly_roots(
            &[
                base.join("Windows"),
                base.join("py"),
                base.join("py").join("Lib"),
                base.join("py"),
            ],
            &[base.join("chat").as_path()],
        );
        assert_eq!(
            roots,
            vec![
                base.join("Windows").display().to_string(),
                base.join("py").display().to_string(),
            ]
        );
    }

    #[test]
    fn grants_no_drive_root_and_nothing_inside_the_chat_folder() {
        let roots = readonly_roots(
            &[
                PathBuf::from("/"),
                PathBuf::from("/data/chat/t1/.packages"),
                PathBuf::from("/opt/py"),
            ],
            &[Path::new("/data/chat/t1")],
        );
        assert_eq!(roots, vec!["/opt/py".to_owned()]);
    }

    #[test]
    fn a_wider_root_replaces_the_narrower_one_it_contains() {
        let roots = readonly_roots(
            &[PathBuf::from("/opt/py/lib"), PathBuf::from("/opt/py")],
            &[Path::new("/w")],
        );
        assert_eq!(roots, vec!["/opt/py".to_owned()]);
    }

    #[test]
    fn round_trips_the_policy_through_base64() {
        let encoded = encode_policy(&policy()).unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&decoded).unwrap(), policy());
    }

    #[test]
    fn refuses_a_policy_too_long_for_the_windows_command_line() {
        let long = "x".repeat(MAX_CONFIG_BASE64);
        let policy = build_policy(&PolicyInput {
            container_id: "atomic-1",
            command_line: &long,
            workdir: Path::new(r"C:\w"),
            user_folders: &[],
            env: &[],
            readonly_paths: &[],
            timeout_ms: 1,
        });
        assert!(encode_policy(&policy).unwrap_err().contains("run_script"));
    }

    #[test]
    fn quotes_arguments_the_way_the_c_runtime_reads_them() {
        assert_eq!(quote_windows_arg("plain"), "plain");
        assert_eq!(quote_windows_arg(""), "\"\"");
        assert_eq!(
            quote_windows_arg(r"C:\Program Files\py.exe"),
            r#""C:\Program Files\py.exe""#
        );
        assert_eq!(quote_windows_arg(r#"say "hi""#), r#""say \"hi\"""#);
        assert_eq!(quote_windows_arg(r"ends\ "), r#""ends\ ""#);
        assert_eq!(quote_windows_arg(r"dir with\"), r#""dir with\\""#);
        assert_eq!(
            windows_command_line(
                r"C:\py\python.exe",
                &["-u".into(), r"C:\my chat\run.py".into()]
            ),
            r#"C:\py\python.exe -u "C:\my chat\run.py""#
        );
    }

    #[test]
    fn hands_cmd_the_command_verbatim() {
        assert_eq!(
            cmd_arguments(r#"echo "a b" && dir"#),
            r#"/d /s /c "echo "a b" && dir""#
        );
    }

    #[test]
    fn reads_mxcs_own_error_line_and_tells_pre_launch_failures_apart() {
        let error = parse_error(
            "workload noise\n{\"error\":{\"code\":\"policy_validation\",\"message\":\"bad env\"}}\n",
        )
        .unwrap();
        assert_eq!(error.code, "policy_validation");
        assert_eq!(error.message, "bad env");
        assert!(is_pre_launch(&error));

        let other = MxcError {
            code: "BackendError".into(),
            message: String::new(),
        };
        assert!(!is_pre_launch(&other));
        assert!(parse_error("Traceback (most recent call last):\n  oops").is_none());
    }

    #[test]
    fn accepts_only_the_base_container_tier() {
        assert!(check_probe_output(r#"{"tier":"base-container","warnings":[]}"#).is_ok());
        let dacl = check_probe_output(
            r#"{"tier":"appcontainer-dacl","warnings":["run wxc-host-prep prepare-system-drive"]}"#,
        )
        .unwrap_err();
        assert!(dacl.contains("appcontainer-dacl"), "{dacl}");
        assert!(dacl.contains("prepare-system-drive"), "{dacl}");
        assert!(check_probe_output("not json").is_err());
    }

    #[test]
    fn spells_the_chat_folder_as_the_home_drive_and_path() {
        assert_eq!(
            split_drive(r"C:\data\chat"),
            ("C:".into(), r"\data\chat".into())
        );
        assert_eq!(split_drive("C:"), ("C:".into(), r"\".into()));

        let env = workload_base_env(Path::new(r"D:\atomic\chat\t1"), &[PathBuf::from(r"D:\py")]);
        let get = |name: &str| {
            env.iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
                .unwrap()
        };
        assert_eq!(get("LOCALAPPDATA"), r"D:\atomic\chat\t1");
        assert_eq!(get("HOMEDRIVE"), "D:");
        assert_eq!(get("HOMEPATH"), r"\atomic\chat\t1");
        assert!(get("PATH").starts_with(r"D:\py"));
        assert!(env.iter().any(|(key, _)| key == "SYSTEMROOT"));
    }
}
