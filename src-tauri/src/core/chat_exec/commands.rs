use std::{
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use tauri::{AppHandle, Manager, Runtime, State};
use tokio_util::sync::CancellationToken;

use super::{
    mxc,
    runner::{self, Launch},
    runtimes::{self, BundledBins, ManagedPython, RuntimeEnv},
    workdir::{self, ChatWorkdir},
    ChatExecRequest, ChatExecResult, ChatExecState, ChatExecStatus, ExecKind, Prepared,
    SandboxKind, SandboxStatus, ScriptLanguage, UserFolder,
};
use crate::core::app::commands::get_jan_data_folder_path;
use crate::core::secure_env::{self, SecureEnvironment};

const DEFAULT_TIMEOUT_SECS: u64 = 120;
/// Same ceiling as the agent's `os.shell.run`.
const MAX_TIMEOUT_SECS: u64 = 600;
const MAX_SOURCE_CHARS: usize = 200_000;

const SUPPORTED: bool = cfg!(not(any(target_os = "android", target_os = "ios")));

/// What chat can run here, and whether secure environment projects can use
/// the sandbox. Probed once per session (on Windows the probe starts a test
/// container).
#[tauri::command]
pub async fn chat_exec_status<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, ChatExecState>,
) -> Result<ChatExecStatus, String> {
    Ok(prepare(&app_handle, &state).await.status.clone())
}

/// Run one approved `run_command` / `run_script` call in the chat's folder.
#[tauri::command]
pub async fn chat_exec_run<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, ChatExecState>,
    request: ChatExecRequest,
) -> Result<ChatExecResult, String> {
    run_request(&app_handle, &state, request).await
}

/// Stop a running call (the user pressed Stop). `false` when it is not running.
#[tauri::command]
pub fn chat_exec_cancel(state: State<'_, ChatExecState>, call_id: String) -> bool {
    state.cancel(&call_id)
}

async fn prepare<R: Runtime>(app: &AppHandle<R>, state: &ChatExecState) -> Arc<Prepared> {
    let mut slot = state.prepared.lock().await;
    if let Some(prepared) = slot.as_ref() {
        return Arc::clone(prepared);
    }
    let prepared = Arc::new(detect(app).await);
    *slot = Some(Arc::clone(&prepared));
    prepared
}

async fn detect<R: Runtime>(app: &AppHandle<R>) -> Prepared {
    let bins = bundled_bins(app);
    let search_path = search_path().await;
    let runtimes = if SUPPORTED {
        runtimes::resolve_all(&RuntimeEnv {
            bins: &bins,
            path: search_path.as_deref(),
        })
    } else {
        Default::default()
    };
    let (sandbox, wxc_exec) = detect_sandbox(app).await;
    let folders = user_folders(app);
    let home = app.path().home_dir().ok();
    let languages = ScriptLanguage::ALL
        .into_iter()
        .filter(|language| runtimes.contains_key(language))
        .collect();
    Prepared {
        status: ChatExecStatus {
            supported: SUPPORTED,
            os: if cfg!(target_os = "macos") {
                "macos"
            } else if cfg!(windows) {
                "windows"
            } else {
                "linux"
            },
            shell: if cfg!(windows) { "cmd" } else { "sh" },
            languages,
            sandbox,
            user_folders: folders
                .iter()
                .map(|(kind, path)| UserFolder {
                    kind,
                    path: folder_for_model(path, home.as_deref()),
                })
                .collect(),
        },
        runtimes,
        bins,
        wxc_exec,
        search_path,
    }
}

/// The user's Desktop, Documents and Downloads as the OS names them: XDG user
/// dirs on Linux (often localized), known folders on Windows (often moved
/// into OneDrive).
fn user_folders<R: Runtime>(app: &AppHandle<R>) -> Vec<(&'static str, PathBuf)> {
    let paths = app.path();
    [
        ("desktop", paths.desktop_dir()),
        ("documents", paths.document_dir()),
        ("downloads", paths.download_dir()),
    ]
    .into_iter()
    .filter_map(|(kind, dir)| dir.ok().filter(|dir| dir.is_dir()).map(|dir| (kind, dir)))
    .collect()
}

/// How a folder is named to the model: `~/…` under the home folder on
/// macOS/Linux, so its descriptions carry no user name; Windows' cmd has no
/// `~`, so there it is the full path.
fn folder_for_model(path: &Path, home: Option<&Path>) -> String {
    if cfg!(not(windows)) {
        if let Some(rest) = home.and_then(|home| path.strip_prefix(home).ok()) {
            return format!("~/{}", rest.display());
        }
    }
    path.display().to_string()
}

/// What the model should be told when the OS or the sandbox, not the
/// command, refused: it otherwise concludes the folder is simply out of its
/// reach. `secure` is set only for a run that went through MXC.
fn failure_hint(
    os: &str,
    secure: Option<&SecureEnvironment>,
    exit_code: Option<i32>,
    output: &str,
) -> Option<String> {
    if exit_code == Some(0) {
        return None;
    }
    let denied = |patterns: &[&str]| patterns.iter().any(|pattern| output.contains(pattern));
    if let Some(environment) = secure {
        if denied(&[
            "Access is denied",
            // PowerShell: "Access to the path '…' is denied."
            "Access to the path",
            "Permission denied",
            "[WinError 5]",
            "Отказано в доступе",
        ]) {
            return Some(
                "This chat belongs to a secure environment project: commands reach only this chat's folder and the project's folders (read-only ones cannot be changed); every other location is blocked on purpose. `dir` and `cd` fail even on the project's folders in this sandbox: list a folder with `for %f in (\"<folder>\\*\") do @echo %~nxf` instead."
                    .into(),
            );
        }
        if !environment.network {
            return Some(
                "This chat belongs to a secure environment project with the network turned off: commands cannot reach the internet. If the failure looks like a network error, tell the user that instead of retrying."
                    .into(),
            );
        }
        return None;
    }
    if os == "macos" && denied(&["Operation not permitted"]) {
        return Some(
            "macOS blocked access to a protected location. If the user declined the system prompt for that folder, they can allow Atomic Chat in System Settings → Privacy & Security → Files and Folders, then run it again."
                .into(),
        );
    }
    None
}

/// Why a secure environment project's command did not run: there is no
/// sandbox to keep it inside the project's folders. The model reads this.
fn secure_without_sandbox(sandbox: &SandboxStatus) -> String {
    let why = sandbox
        .reason
        .as_deref()
        .unwrap_or("this computer has no sandbox for commands");
    format!(
        "This chat belongs to a secure environment project. Its commands run only inside the Windows sandbox, which is not available here ({why}). Nothing was run; tell the user instead of retrying."
    )
}

/// Sidecars sit beside the executable; bundled resources under
/// `<resource dir>/resources/bin`.
fn bundled_bins<R: Runtime>(app: &AppHandle<R>) -> BundledBins {
    let mut dirs = Vec::new();
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
    {
        dirs.push(dir);
    }
    if let Ok(resources) = app.path().resource_dir() {
        dirs.push(resources.join("resources").join("bin"));
    }
    dirs.retain(|dir| dir.is_dir());
    dirs.dedup();
    BundledBins { dirs }
}

/// The PATH interpreters are looked up on and commands inherit: the login
/// shell's on macOS/Linux (a GUI app only gets launchd's minimal one).
async fn search_path() -> Option<OsString> {
    #[cfg(not(windows))]
    {
        let login = tokio::task::spawn_blocking(crate::core::system::commands::login_shell_path)
            .await
            .ok()
            .flatten();
        if let Some(path) = login {
            return Some(OsString::from(path));
        }
    }
    std::env::var_os("PATH")
}

#[cfg(windows)]
async fn detect_sandbox<R: Runtime>(app: &AppHandle<R>) -> (SandboxStatus, Option<PathBuf>) {
    if !matches!(std::env::consts::ARCH, "x86_64" | "aarch64") {
        return (
            no_sandbox("The Windows sandbox needs an x64 or Arm64 PC"),
            None,
        );
    }
    let Some(wxc_exec) = app
        .path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join(mxc::WXC_EXEC_RESOURCE))
        // `make stub-resources` leaves an empty placeholder in dev trees.
        .filter(|path| {
            path.metadata()
                .is_ok_and(|meta| meta.is_file() && meta.len() > 0)
        })
    else {
        return (
            no_sandbox("This build does not include the Windows sandbox (MXC)"),
            None,
        );
    };
    let scratch = workdir::chat_root(&get_jan_data_folder_path(app.clone()));
    if let Err(error) = std::fs::create_dir_all(&scratch) {
        return (
            no_sandbox(&format!("Could not prepare the Windows sandbox: {error}")),
            None,
        );
    }
    match mxc::probe(&wxc_exec, &scratch).await {
        Ok(()) => (
            SandboxStatus {
                kind: SandboxKind::Mxc,
                reason: None,
            },
            Some(wxc_exec),
        ),
        Err(reason) => {
            log::warn!("chat_exec: Windows sandbox unavailable: {reason}");
            (no_sandbox(&reason), None)
        }
    }
}

#[cfg(not(windows))]
async fn detect_sandbox<R: Runtime>(_app: &AppHandle<R>) -> (SandboxStatus, Option<PathBuf>) {
    (
        SandboxStatus {
            kind: SandboxKind::None,
            reason: None,
        },
        None,
    )
}

#[cfg(windows)]
fn no_sandbox(reason: &str) -> SandboxStatus {
    SandboxStatus {
        kind: SandboxKind::None,
        reason: Some(reason.to_owned()),
    }
}

/// After MXC reported a failure before its workload started: probe again,
/// and stop running secure projects' commands only when the probe — not the
/// workload's stderr, which it controls — agrees.
async fn recheck_sandbox<R: Runtime>(app: &AppHandle<R>, state: &ChatExecState) {
    let (sandbox, wxc_exec) = detect_sandbox(app).await;
    let mut slot = state.prepared.lock().await;
    let Some(current) = slot.as_ref() else {
        return;
    };
    if sandbox.kind == current.status.sandbox.kind {
        return;
    }
    let mut status = current.status.clone();
    status.sandbox = sandbox;
    *slot = Some(Arc::new(Prepared {
        status,
        runtimes: current.runtimes.clone(),
        bins: current.bins.clone(),
        wxc_exec,
        search_path: current.search_path.clone(),
    }));
}

async fn managed_python(
    state: &ChatExecState,
    prepared: &Prepared,
    data_folder: &Path,
    cancel: &CancellationToken,
) -> Result<ManagedPython, String> {
    let mut slot = state.python.lock().await;
    if let Some(python) = slot.as_ref().filter(|python| python.executable.is_file()) {
        return Ok(python.clone());
    }
    let uv = prepared
        .bins
        .find("uv")
        .ok_or("Python needs the bundled uv, which this build does not include")?;
    // The same uv cache the MCP servers' `uvx` uses.
    let python = runtimes::ensure_managed_python(&uv, &data_folder.join(".uvx"), cancel).await?;
    *slot = Some(python.clone());
    Ok(python)
}

async fn run_request<R: Runtime>(
    app: &AppHandle<R>,
    state: &ChatExecState,
    request: ChatExecRequest,
) -> Result<ChatExecResult, String> {
    let prepared = prepare(app, state).await;
    if !prepared.status.supported {
        return Err("Running commands is not available on this platform".into());
    }
    if request.source.trim().is_empty() {
        return Err("Nothing to run".into());
    }
    if request.source.chars().count() > MAX_SOURCE_CHARS {
        return Err(format!(
            "The {} is longer than {MAX_SOURCE_CHARS} characters",
            if request.kind == ExecKind::Command {
                "command"
            } else {
                "script"
            }
        ));
    }
    let data_folder = get_jan_data_folder_path(app.clone());
    // Only a secure environment project's commands go through MXC, and
    // there they run inside it or not at all: on the host they would reach
    // every folder the user can. Every other chat runs on the host, gated by
    // its approval mode.
    let secure = secure_env::for_thread(&data_folder, &request.thread_id)?;
    let sandbox = match &secure {
        Some(environment) => {
            let wxc_exec = prepared
                .wxc_exec
                .as_deref()
                .filter(|_| prepared.status.sandbox.kind == SandboxKind::Mxc)
                .ok_or_else(|| secure_without_sandbox(&prepared.status.sandbox))?;
            Some((environment, wxc_exec))
        }
        None => None,
    };
    let sandboxed = sandbox.is_some();
    let workdir = workdir::ensure_chat_workdir(&data_folder, &request.thread_id)?;
    let timeout_secs = request
        .timeout_seconds
        .unwrap_or(DEFAULT_TIMEOUT_SECS)
        .clamp(1, MAX_TIMEOUT_SECS);
    let run = state.register(&request.call_id, &request.thread_id)?;
    let cancel = run.token.clone();

    // A Python script needs the interpreter (installed on first use, outside
    // the call's timeout); a command gets it on PATH once it is known.
    let script_language = match request.kind {
        ExecKind::Script => Some(request.language.ok_or("run_script needs a language")?),
        ExecKind::Command => None,
    };
    let wants_python = match script_language {
        Some(language) => language == ScriptLanguage::Python,
        None => mentions_python(&request.source),
    };
    let python = if wants_python && prepared.bins.find("uv").is_some() {
        Some(managed_python(state, &prepared, &data_folder, &cancel).await?)
    } else {
        state.python.lock().await.clone()
    };

    let mut script_file = None;
    let (program, args, raw_args) = match script_language {
        None => command_invocation(&request.source)?,
        Some(language) => {
            let runtime = prepared.runtimes.get(&language).ok_or_else(|| {
                format!(
                    "{} is not available on this computer",
                    language_label(language)
                )
            })?;
            let file = workdir.scripts().join(format!(
                "run-{}.{}",
                uuid::Uuid::new_v4().simple(),
                runtimes::script_extension(language)
            ));
            std::fs::write(&file, &request.source)
                .map_err(|error| format!("Could not write the script: {error}"))?;
            script_file = Some(file.clone());
            let (program, args) = runtimes::invocation(runtime, &file, python.as_ref())?;
            (program, args, None)
        }
    };

    let path_dirs = python
        .as_ref()
        .map(ManagedPython::path_dirs)
        .unwrap_or_default();
    let launch = match sandbox {
        Some((environment, wxc_exec)) => {
            let (writable_folders, project_readonly) = environment.existing_roots();
            let mut readonly = vec![mxc::system_root()];
            readonly.extend(prepared.bins.dirs.iter().cloned());
            readonly.extend(python.as_ref().map(|python| python.base_prefix.clone()));
            readonly.extend(
                script_language
                    .and_then(|language| prepared.runtimes.get(&language))
                    .and_then(|runtime| runtime.install_root()),
            );
            let host_path = host_path_dirs(prepared.search_path.as_deref());
            readonly.extend(host_path.iter().cloned());
            readonly.extend(project_readonly);
            let mut workload_path = path_dirs.clone();
            workload_path.extend(prepared.bins.dirs.iter().cloned());
            workload_path.extend(host_path);
            let mut env = mxc::workload_base_env(&workdir.root, &workload_path);
            env.extend(common_env(&workdir));
            let command_line = match &raw_args {
                Some(raw) => format!("{} {raw}", mxc::quote_windows_arg(&program)),
                None => mxc::windows_command_line(&program, &args),
            };
            let container_id = format!("atomic-{}", uuid::Uuid::new_v4().simple());
            let policy = mxc::build_policy(&mxc::PolicyInput {
                container_id: &container_id,
                command_line: &command_line,
                workdir: &workdir.root,
                writable_folders: &writable_folders,
                env: &env,
                readonly_paths: &readonly,
                timeout_ms: timeout_secs * 1000,
                network: environment.network,
            });
            mxc::executor_launch(wxc_exec, mxc::encode_policy(&policy)?)
        }
        None => host_launch(
            program,
            args,
            raw_args,
            &workdir,
            &path_dirs,
            prepared.search_path.as_deref(),
        ),
    };
    let host_timeout = Duration::from_secs(
        timeout_secs
            + if sandboxed {
                mxc::HOST_TIMEOUT_GRACE_SECS
            } else {
                0
            },
    );
    let output = runner::run(&launch, host_timeout, &cancel).await;
    if let Some(file) = script_file {
        let _ = std::fs::remove_file(file);
    }
    let output = output?;

    let mut timed_out = output.timed_out;
    if sandboxed && output.exit_code != Some(0) {
        if let Some(error) = mxc::parse_error(&output.stderr) {
            if mxc::is_timeout(&error) {
                timed_out = true;
            } else if mxc::is_pre_launch(&error) {
                log::warn!(
                    "chat_exec: MXC refused a run ({}): {}",
                    error.code,
                    error.message
                );
                recheck_sandbox(app, state).await;
            }
        }
    }
    drop(run);
    let hint = failure_hint(
        prepared.status.os,
        secure.as_ref(),
        output.exit_code,
        &format!("{}\n{}", output.stdout, output.stderr),
    );
    Ok(ChatExecResult {
        exit_code: output.exit_code,
        stdout: output.stdout,
        stderr: output.stderr,
        truncated: output.truncated,
        timed_out,
        cancelled: output.cancelled,
        sandbox: if sandboxed {
            SandboxKind::Mxc
        } else {
            SandboxKind::None
        },
        workdir: workdir.root.display().to_string(),
        duration_ms: u64::try_from(output.duration.as_millis()).unwrap_or(u64::MAX),
        hint,
    })
}

/// A command that runs `python` or `pip` gets the app's Python first on
/// PATH, so a package it installs is the one `run_script` imports.
fn mentions_python(command: &str) -> bool {
    command
        .split(|ch: char| !(ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-')))
        .any(|word| {
            let word = word.trim_end_matches(".exe");
            matches!(word, "python" | "python3" | "pip" | "pip3")
                || word.strip_prefix("python3.").is_some_and(|minor| {
                    !minor.is_empty() && minor.chars().all(|ch| ch.is_ascii_digit())
                })
        })
}

fn language_label(language: ScriptLanguage) -> String {
    serde_json::to_value(language)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| format!("{language:?}"))
}

/// The shell a command line goes through: `sh -c`, or `cmd /d /s /c` with
/// the line passed verbatim (cmd does its own parsing).
fn command_invocation(source: &str) -> Result<(String, Vec<String>, Option<String>), String> {
    if source.contains('\0') {
        return Err("The command contains a NUL character".into());
    }
    #[cfg(windows)]
    {
        if source.contains(['\n', '\r']) {
            return Err(
                "cmd runs one line at a time: join the commands with && or put them in a script with run_script (language \"shell\")."
                    .into(),
            );
        }
        let cmd = mxc::system_root().join("System32").join("cmd.exe");
        Ok((
            cmd.display().to_string(),
            Vec::new(),
            Some(mxc::cmd_arguments(source)),
        ))
    }
    #[cfg(not(windows))]
    Ok(("/bin/sh".into(), vec!["-c".into(), source.to_owned()], None))
}

/// Variables every run gets: temp files, Python packages and bun's cache stay
/// in the chat's folder; output is plain text for a pipe.
fn common_env(workdir: &ChatWorkdir) -> Vec<(String, String)> {
    let text = |path: PathBuf| path.display().to_string();
    vec![
        ("TMPDIR".into(), text(workdir.tmp())),
        ("TMP".into(), text(workdir.tmp())),
        ("TEMP".into(), text(workdir.tmp())),
        ("PIP_TARGET".into(), text(workdir.packages())),
        ("PYTHONPATH".into(), text(workdir.packages())),
        ("PIP_DISABLE_PIP_VERSION_CHECK".into(), "1".into()),
        ("PYTHONUTF8".into(), "1".into()),
        ("PYTHONIOENCODING".into(), "utf-8".into()),
        ("MPLBACKEND".into(), "Agg".into()),
        ("BUN_INSTALL".into(), text(workdir.bun())),
        ("NO_COLOR".into(), "1".into()),
        ("TERM".into(), "dumb".into()),
    ]
}

fn host_launch(
    program: String,
    args: Vec<String>,
    raw_args: Option<String>,
    workdir: &ChatWorkdir,
    path_dirs: &[PathBuf],
    search_path: Option<&OsStr>,
) -> Launch {
    let mut env = common_env(workdir);
    let mut path: Vec<PathBuf> = path_dirs.to_vec();
    if let Some(search_path) = search_path {
        path.extend(std::env::split_paths(search_path));
    }
    if let Ok(joined) = std::env::join_paths(path) {
        env.push(("PATH".into(), joined.to_string_lossy().into_owned()));
    }
    Launch {
        program,
        args,
        raw_args,
        cwd: workdir.root.clone(),
        env,
        clear_env: false,
    }
}

/// The user's PATH folders a sandboxed command may run programs from (read
/// only): absolute, existing, never a drive root or the profile folder that
/// holds everything else.
fn host_path_dirs(search_path: Option<&OsStr>) -> Vec<PathBuf> {
    let profile = std::env::var_os("USERPROFILE").map(PathBuf::from);
    search_path
        .map(std::env::split_paths)
        .into_iter()
        .flatten()
        .filter(|dir| dir.is_absolute() && dir.parent().is_some() && dir.is_dir())
        .filter(|dir| {
            profile
                .as_ref()
                .map_or(true, |profile| !profile.starts_with(dir))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::agent::test_support::TestWorkspace;

    #[test]
    fn host_runs_see_the_chat_folders_and_the_python_first_on_path() {
        let data = TestWorkspace::new();
        let workdir = workdir::ensure_chat_workdir(data.path(), "t1").unwrap();
        let search = std::env::join_paths(["/usr/bin"]).unwrap();
        let launch = host_launch(
            "/bin/sh".into(),
            vec!["-c".into(), "true".into()],
            None,
            &workdir,
            &[PathBuf::from("/py/bin")],
            Some(&search),
        );
        let get = |name: &str| {
            launch
                .env
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
        };

        assert_eq!(launch.cwd, workdir.root);
        assert!(!launch.clear_env);
        assert_eq!(
            get("PIP_TARGET"),
            Some(workdir.packages().display().to_string())
        );
        assert_eq!(get("TMPDIR"), Some(workdir.tmp().display().to_string()));
        let path = get("PATH").unwrap();
        assert!(path.starts_with("/py/bin"), "{path}");
        assert!(path.contains("/usr/bin"), "{path}");
    }

    #[test]
    fn refuses_a_command_with_a_nul() {
        assert!(command_invocation("echo a\0b").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn runs_commands_through_sh() {
        assert_eq!(
            command_invocation("ls | wc -l").unwrap(),
            (
                "/bin/sh".into(),
                vec!["-c".into(), "ls | wc -l".into()],
                None
            )
        );
    }

    #[cfg(windows)]
    #[test]
    fn runs_one_line_through_cmd_verbatim() {
        let (program, args, raw) = command_invocation(r#"echo "a b" && dir"#).unwrap();
        assert!(program.to_ascii_lowercase().ends_with(r"system32\cmd.exe"));
        assert!(args.is_empty());
        assert_eq!(raw.unwrap(), r#"/d /s /c "echo "a b" && dir""#);
        assert!(command_invocation("echo a\necho b").is_err());
    }

    #[test]
    fn grants_no_drive_root_or_profile_folder_from_path() {
        let dirs = host_path_dirs(Some(OsStr::new("relative")));
        assert!(dirs.is_empty());
        let root = std::env::join_paths([Path::new("/")]).unwrap();
        assert!(host_path_dirs(Some(&root)).is_empty());
    }

    #[test]
    fn notices_a_command_that_runs_python_or_pip() {
        for command in [
            "python -m pip install requests",
            "pip3 install numpy",
            "python3.12 script.py",
            "cd data && python.exe run.py",
        ] {
            assert!(mentions_python(command), "{command}");
        }
        for command in [
            "ls -la",
            "echo pythonic",
            "cat my_python_notes.txt",
            "pipx list",
        ] {
            assert!(!mentions_python(command), "{command}");
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn names_the_users_folders_from_home_without_the_user_name() {
        let home = Path::new("/Users/someone");
        assert_eq!(
            folder_for_model(Path::new("/Users/someone/Desktop"), Some(home)),
            "~/Desktop"
        );
        assert_eq!(
            folder_for_model(Path::new("/Users/someone/Рабочий стол"), Some(home)),
            "~/Рабочий стол"
        );
        assert_eq!(
            folder_for_model(Path::new("/mnt/data/Downloads"), Some(home)),
            "/mnt/data/Downloads"
        );
    }

    #[test]
    fn explains_a_refusal_the_os_made() {
        let mac = failure_hint(
            "macos",
            None,
            Some(1),
            "ls: Desktop: Operation not permitted",
        );
        assert!(mac.unwrap().contains("Files and Folders"));

        // Not the OS's doing, or nothing failed: no hint. An ordinary chat's
        // command runs on the host, so an access error there is the user's own.
        assert!(failure_hint("windows", None, Some(1), "Access is denied.").is_none());
        assert!(failure_hint("linux", None, Some(1), "Operation not permitted").is_none());
        assert!(failure_hint("macos", None, Some(0), "Operation not permitted").is_none());
        assert!(failure_hint("macos", None, Some(2), "No such file or directory").is_none());
    }

    #[test]
    fn a_secure_project_explains_its_own_reach() {
        let closed = SecureEnvironment {
            folders: Vec::new(),
            network: false,
            allowed_mcp_servers: Vec::new(),
        };
        let denied = failure_hint("windows", Some(&closed), Some(1), "Access is denied.");
        assert!(denied.unwrap().contains("project's folders"));
        assert!(failure_hint("windows", Some(&closed), Some(1), "Отказано в доступе.").is_some());
        let powershell = failure_hint(
            "windows",
            Some(&closed),
            Some(1),
            "Get-ChildItem : Access to the path 'C:\\Users\\me\\Documents' is denied.",
        );
        assert!(powershell.unwrap().contains("project's folders"));
        let offline = failure_hint("windows", Some(&closed), Some(1), "getaddrinfo failed");
        assert!(offline.unwrap().contains("network turned off"));

        let open = SecureEnvironment {
            folders: Vec::new(),
            network: true,
            allowed_mcp_servers: Vec::new(),
        };
        assert!(failure_hint("windows", Some(&open), Some(1), "SyntaxError").is_none());
    }

    #[test]
    fn a_secure_project_refuses_to_run_without_the_sandbox() {
        let message = secure_without_sandbox(&SandboxStatus {
            kind: SandboxKind::None,
            reason: Some("Windows 11 24H2 is required".into()),
        });
        assert!(message.contains("secure environment"));
        assert!(message.contains("Windows 11 24H2 is required"));
        assert!(message.contains("Nothing was run"));
    }

    #[test]
    fn names_languages_the_way_the_tool_schema_does() {
        assert_eq!(language_label(ScriptLanguage::Python), "python");
        assert_eq!(language_label(ScriptLanguage::R), "r");
    }

    /// Needs `uv` (`ATOMIC_TEST_UV`, else on PATH) and may download CPython:
    /// `cargo test --lib chat_exec -- --ignored`.
    #[cfg(unix)]
    #[tokio::test]
    #[ignore]
    async fn runs_python_with_the_managed_interpreter_and_the_chats_packages() {
        let uv = std::env::var_os("ATOMIC_TEST_UV")
            .map(PathBuf::from)
            .or_else(|| runtimes::find_on_path("uv", std::env::var_os("PATH").as_deref()))
            .expect("uv for this test");
        let data = TestWorkspace::new();
        let cancel = CancellationToken::new();
        let python = runtimes::ensure_managed_python(&uv, &data.path().join(".uvx"), &cancel)
            .await
            .unwrap();
        assert!(python.base_prefix.is_absolute());

        let workdir = workdir::ensure_chat_workdir(data.path(), "t1").unwrap();
        // A package installed into this chat is importable by its scripts.
        std::fs::write(workdir.packages().join("chatpkg.py"), "VALUE = 42\n").unwrap();
        let script = workdir.scripts().join("run.py");
        std::fs::write(
            &script,
            "import sys, chatpkg\nprint(sys.version_info[:2], chatpkg.VALUE)\n",
        )
        .unwrap();
        let (program, args) =
            runtimes::invocation(&runtimes::Runtime::ManagedPython, &script, Some(&python))
                .unwrap();
        let launch = host_launch(program, args, None, &workdir, &python.path_dirs(), None);

        let output = runner::run(&launch, Duration::from_secs(60), &cancel)
            .await
            .unwrap();

        assert_eq!(output.exit_code, Some(0), "{}", output.stderr);
        assert_eq!(output.stdout.trim(), "(3, 12) 42");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runs_a_command_in_the_chat_folder() {
        let data = TestWorkspace::new();
        let workdir = workdir::ensure_chat_workdir(data.path(), "t1").unwrap();
        let (program, args, raw) = command_invocation("pwd; echo hi > made.txt").unwrap();
        let launch = host_launch(
            program,
            args,
            raw,
            &workdir,
            &[],
            std::env::var_os("PATH").as_deref(),
        );

        let output = runner::run(&launch, Duration::from_secs(10), &CancellationToken::new())
            .await
            .unwrap();

        assert_eq!(output.exit_code, Some(0));
        let printed = PathBuf::from(output.stdout.trim());
        assert_eq!(
            std::fs::canonicalize(printed).unwrap(),
            std::fs::canonicalize(&workdir.root).unwrap()
        );
        assert!(workdir.root.join("made.txt").is_file());
    }
}
