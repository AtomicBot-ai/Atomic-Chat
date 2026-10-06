//! The one privileged step of a TensorRT-LLM setup: on Linux, installing Docker Engine and the
//! NVIDIA Container Toolkit (openspec change `add-tensorrt-llm-linux`, design D3); on Windows,
//! enabling WSL (change `add-tensorrt-llm-windows`, design D2/D15).
//!
//! The core never runs anything as root or as an administrator. It hands out a
//! `pending_host_step` on the operation and reads a receipt back; the privileged work is done by
//! its own recipe executor, the `host-step exec <request-file>` subcommand of the core binary, run
//! as a separate process under `pkexec` (Linux) or through the UAC prompt (Windows). That process
//! talks to nobody: it reads the request file and writes a result file next to it.
//!
//! Here the app does its half:
//!
//! - it reads the step from the core itself, by operation id: the webview names the operation and
//!   never hands over a path, a command or a parameter;
//! - on Linux it copies the core binary into a fresh `0700` folder under `$XDG_RUNTIME_DIR` and
//!   runs `pkexec` on the copy. The AppImage is a FUSE mount without `allow_other`, which root
//!   cannot read, so `pkexec` on the binary inside the bundle would fail;
//! - on Windows it runs the bundled `atomic-chat-core.exe` itself (`ShellExecuteExW` with `runas`,
//!   [`super::host_step_windows`]), from a fresh folder under `%LOCALAPPDATA%` that only the user,
//!   `SYSTEM` and `Administrators` can touch — no copy: the install folder is already trusted, and
//!   UAC shows the signed publisher;
//! - it writes the request file (`0600` on Linux, never trusting the umask), waits for the
//!   executor, reads the result file and sends the receipt;
//! - with no `pkexec` or no polkit agent, it hands the person the exact `sudo` command and keeps
//!   waiting for the result file instead; where UAC cannot be raised, it hands over
//!   `wsl --install` for an administrator terminal (the inbox `wsl.exe` stub runs only the bare form).
//!
//! The copy (Linux) and the request folder are removed once the executor has exited.

use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::process::Stdio;
#[cfg(unix)]
use std::time::Duration;

use serde_json::{json, Value};

/// The copy's file name inside its folder.
#[cfg(unix)]
const CORE_COPY_NAME: &str = "atomic-chat-core";

/// What `pkexec` prints when there is no polkit agent to ask the password with (minimal window
/// managers, a bare session): it exits 127 right away, as it does for a refusal.
#[cfg(unix)]
const NO_AGENT_MARKER: &str = "No authentication agent";

/// How often the result file is looked for while the person runs the `sudo` command.
#[cfg(unix)]
pub const MANUAL_POLL_INTERVAL: Duration = Duration::from_secs(2);

/// The app core's file name, and the CLI core's: the pair `yarn download:core` bundles and
/// `npm run build:bin` builds side by side (with a `-<triple>` suffix there).
const APP_CORE_NAME: &str = "atomic-chat-app-core";
const CLI_CORE_NAME: &str = "atomic-chat-core";

/// The binary that executes a privileged step: the CLI core next to the core the app runs.
///
/// Only the CLI core has `host-step exec`; the app core accepts nothing but `daemon` (manual run
/// F-1). The pair always sits together — `resources/bin` in the app bundle and the AppImage, and
/// `dist/bin` of a local core build that `ATOMIC_CORE_CMD` points at in development (F-3) — so the
/// executor is found from the same command the app starts its core with, never from a second place
/// that could hold another build.
pub fn executor_binary(command: &super::launch::CoreCommand) -> Result<PathBuf, String> {
    if !command.prefix.is_empty() {
        return Err(format!(
            "The core runs from source ({} …), which has no compiled `{CLI_CORE_NAME}` to run the \
             privileged step with. Build the core (`npm run build:bin`) and point ATOMIC_CORE_CMD \
             at the `{APP_CORE_NAME}` binary it builds.",
            command.program
        ));
    }
    let program = Path::new(&command.program);
    let name = program
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| name.starts_with(APP_CORE_NAME))
        .ok_or_else(|| {
            format!(
                "The core `{}` is not an `{APP_CORE_NAME}` build, so its `{CLI_CORE_NAME}` twin cannot be found.",
                program.display()
            )
        })?;
    let executor = program.with_file_name(name.replacen(APP_CORE_NAME, CLI_CORE_NAME, 1));
    if !executor.is_file() {
        return Err(format!(
            "`{}` is missing: the privileged step runs on the CLI core that ships beside the app core.",
            executor.display()
        ));
    }
    Ok(executor)
}

/// Steps whose executor is running now, in this app. A second run of the same step would race the
/// first over the package manager, and its receipt would be refused.
static IN_FLIGHT: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// Holds a step for one run; released when dropped, however the run ends.
#[derive(Debug)]
pub struct StepClaim(String);

impl Drop for StepClaim {
    fn drop(&mut self) {
        if let Ok(mut steps) = IN_FLIGHT.lock() {
            steps.retain(|step| step != &self.0);
        }
    }
}

/// Claim `step_id` for one run, or `None` while another run of it is still going.
pub fn claim(step_id: &str) -> Option<StepClaim> {
    let mut steps = IN_FLIGHT.lock().ok()?;
    if steps.iter().any(|step| step == step_id) {
        return None;
    }
    steps.push(step_id.to_string());
    Some(StepClaim(step_id.to_string()))
}

/// The step as the core hands it out on `pending_host_step`, plus the operation it belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostStep {
    pub operation_id: String,
    pub step_id: String,
    pub action: String,
    pub recipe_id: String,
    pub recipe_digest: String,
    pub parameters_digest: String,
    pub nonce: String,
    pub expected_operation_revision: u64,
    pub parameters: Value,
}

impl HostStep {
    /// Read from an operation the core returned. `None` when it has no step pending.
    pub fn from_operation(operation: &Value) -> Option<Self> {
        let step = operation.get("pending_host_step")?;
        let text = |key: &str| step.get(key).and_then(Value::as_str).map(str::to_string);
        Some(Self {
            operation_id: operation.get("operation_id")?.as_str()?.to_string(),
            step_id: text("step_id")?,
            action: text("action")?,
            recipe_id: text("recipe_id")?,
            recipe_digest: text("recipe_digest")?,
            parameters_digest: text("parameters_digest")?,
            nonce: text("nonce")?,
            expected_operation_revision: step.get("expected_operation_revision")?.as_u64()?,
            parameters: step.get("parameters")?.clone(),
        })
    }

    /// The request file, in the shape the core's `parseHostStepRequest` accepts.
    pub(super) fn request(&self, data_folder: &Path, requested_at_ms: u128) -> Value {
        json!({
            "schema_version": 1,
            "step_id": self.step_id,
            "operation_id": self.operation_id,
            "action": self.action,
            "recipe_id": self.recipe_id,
            "recipe_digest": self.recipe_digest,
            "parameters_digest": self.parameters_digest,
            "nonce": self.nonce,
            "expected_operation_revision": self.expected_operation_revision,
            "data_folder": data_folder.to_string_lossy(),
            "requested_at": requested_at_ms as u64,
            "parameters": self.parameters,
        })
    }

    /// The receipt the core's `host-step-result` route takes. An assertion, not proof: the core
    /// probes the machine again before it believes a `completed`.
    pub fn receipt(&self, outcome: ReceiptOutcome, receipt_id: &str) -> Value {
        json!({
            "step_id": self.step_id,
            "nonce": self.nonce,
            "expected_operation_revision": self.expected_operation_revision,
            "recipe_digest": self.recipe_digest,
            "parameters_digest": self.parameters_digest,
            "outcome": outcome.as_str(),
            "receipt_id": receipt_id,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReceiptOutcome {
    Completed,
    Declined,
    Failed,
    /// The step took, and the machine needs a restart before it counts (Windows: WSL just
    /// enabled). The core waits in `reboot-required` and goes on after the restart.
    RebootRequired,
}

impl ReceiptOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Declined => "declined",
            Self::Failed => "failed",
            Self::RebootRequired => "reboot-required",
        }
    }
}

/// How one attempt at the privileged step ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Elevation {
    /// The executor ran and wrote its result file (or, exiting without one, failed).
    Finished { outcome: ReceiptOutcome, log_tail: String },
    /// The person closed the authorization prompt or could not authenticate. Nothing changed on
    /// the machine; the setup can be resumed.
    Declined,
    /// No `pkexec` or no polkit agent: the person runs this command in a terminal, and the result
    /// file it writes is picked up by [`wait_for_result`]. On Windows, UAC could not be raised:
    /// the command is for an administrator terminal and writes no result file.
    Manual { command: String },
}

/// A request laid out on disk: the folder, the copy of the core, the request and result files.
#[derive(Debug)]
pub struct PreparedStep {
    pub dir: PathBuf,
    pub binary: PathBuf,
    pub request: PathBuf,
    pub result: PathBuf,
}

impl PreparedStep {
    /// What a person runs by hand when no automatic elevation is available.
    #[cfg(unix)]
    pub fn manual_command(&self) -> String {
        format!(
            "sudo {} host-step exec {}",
            shell_quote(&self.binary),
            shell_quote(&self.request)
        )
    }

    /// Remove the copy, the request and the result. Never fails loudly: a leftover folder in the
    /// runtime directory is cleared at logout.
    pub fn remove(&self) {
        if let Err(error) = std::fs::remove_dir_all(&self.dir) {
            log::warn!("[host-step] could not remove {}: {error}", self.dir.display());
        }
    }
}

#[cfg(unix)]
fn shell_quote(path: &Path) -> String {
    let text = path.to_string_lossy();
    if text.chars().all(|c| c.is_ascii_alphanumeric() || "/._-".contains(c)) {
        text.into_owned()
    } else {
        format!("'{}'", text.replace('\'', r"'\''"))
    }
}

/// Lay the step out in a fresh folder under `runtime_dir`: `0700` folder, `0700` copy of the core,
/// `0600` request. The folder must not exist yet — a name another process chose is never reused.
#[cfg(unix)]
pub fn prepare(
    runtime_dir: &Path,
    core_binary: &Path,
    step: &HostStep,
    data_folder: &Path,
) -> std::io::Result<PreparedStep> {
    use std::io::Write;
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};

    let dir = runtime_dir.join(format!("atomic-chat-host-step-{}", uuid::Uuid::new_v4().simple()));
    std::fs::DirBuilder::new().mode(0o700).create(&dir)?;
    // The umask may have taken bits away from the mode; set it exactly.
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;

    let prepared = PreparedStep {
        binary: dir.join(CORE_COPY_NAME),
        request: dir.join(format!("{}.request.json", step.step_id)),
        result: dir.join(format!("{}.result.json", step.step_id)),
        dir,
    };
    let laid_out = (|| {
        std::fs::copy(core_binary, &prepared.binary)?;
        std::fs::set_permissions(&prepared.binary, std::fs::Permissions::from_mode(0o700))?;
        let requested_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default();
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&prepared.request)?;
        file.write_all(step.request(data_folder, requested_at).to_string().as_bytes())?;
        file.sync_all()?;
        std::fs::set_permissions(&prepared.request, std::fs::Permissions::from_mode(0o600))
    })();
    if let Err(error) = laid_out {
        prepared.remove();
        return Err(error);
    }
    Ok(prepared)
}

/// Run the executor on the copy under `pkexec` and wait for it.
#[cfg(unix)]
pub async fn elevate(pkexec: &Path, prepared: &PreparedStep) -> Elevation {
    let output = tokio::process::Command::new(pkexec)
        .arg(&prepared.binary)
        .arg("host-step")
        .arg("exec")
        .arg(&prepared.request)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .output()
        .await;
    let output = match output {
        Ok(output) => output,
        // No `pkexec` on this machine at all.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Elevation::Manual { command: prepared.manual_command() }
        }
        Err(error) => {
            return Elevation::Finished {
                outcome: ReceiptOutcome::Failed,
                log_tail: format!("could not start pkexec: {error}"),
            }
        }
    };
    let stderr = String::from_utf8_lossy(&output.stderr);
    match output.status.code() {
        // The authorization dialog was dismissed.
        Some(126) => Elevation::Declined,
        Some(127) if stderr.contains(NO_AGENT_MARKER) => {
            Elevation::Manual { command: prepared.manual_command() }
        }
        // Not authorized, or the password was never right.
        Some(127) => Elevation::Declined,
        code => finished(prepared, code, &stderr),
    }
}

/// The executor exited: its result file is the answer, and no result file is a failure.
fn finished(prepared: &PreparedStep, code: Option<i32>, stderr: &str) -> Elevation {
    match read_result(&prepared.result) {
        Some((outcome, log_tail)) => Elevation::Finished { outcome, log_tail },
        None => Elevation::Finished {
            outcome: ReceiptOutcome::Failed,
            log_tail: format!(
                "the privileged step exited with {} and wrote no result: {}",
                code.map(|c| c.to_string()).unwrap_or_else(|| "a signal".into()),
                tail(stderr)
            ),
        },
    }
}

/// The outcome in the executor's result file — `completed`, `reboot-required`, anything else a
/// failure; `None` while there is none.
pub fn read_result(path: &Path) -> Option<(ReceiptOutcome, String)> {
    let text = std::fs::read_to_string(path).ok()?;
    let result: Value = serde_json::from_str(&text).ok()?;
    let mut log_tail = result
        .get("log_tail")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let outcome = match result.get("outcome").and_then(Value::as_str) {
        Some("completed") => ReceiptOutcome::Completed,
        Some("reboot-required") => ReceiptOutcome::RebootRequired,
        _ => ReceiptOutcome::Failed,
    };
    // The step that failed, its exit code and its own stderr come first: the tail of the log alone
    // did not say which change broke (manual run F-2).
    let failed = result
        .get("steps")
        .and_then(Value::as_array)
        .and_then(|steps| steps.iter().find(|step| step.get("status").and_then(Value::as_str) == Some("failed")));
    if let Some(step) = failed {
        let id = step.get("id").and_then(Value::as_str).unwrap_or("a step");
        let code = step
            .get("exit_code")
            .and_then(Value::as_i64)
            .map(|code| format!(" (exit {code})"))
            .unwrap_or_default();
        let stderr = step.get("stderr").and_then(Value::as_str).unwrap_or_default().trim();
        let detail = step.get("detail").and_then(Value::as_str).unwrap_or_default().trim();
        let why = if stderr.is_empty() { detail } else { stderr };
        log_tail = format!("{id} failed{code}: {why}\n{log_tail}");
    }
    Some((outcome, log_tail))
}

/// `ERROR_CANCELLED`: the person closed the UAC prompt (or answered no).
pub const ERROR_CANCELLED: i32 = 1223;

/// What a person runs in an administrator terminal where UAC cannot be raised (design D15). The
/// only step Windows elevates is `windows.enable-wsl`, and this is all its executor does.
pub const ENABLE_WSL_MANUAL_COMMAND: &str = "wsl --install";

/// How an elevated run on Windows ended, from what `ShellExecuteExW` answered: the executor's
/// exit code once it ran, or the Win32 error when it never started. A cancelled prompt is a
/// decline; any other refusal (UAC turned off by policy, no consent UI) means elevation is not
/// available here, so the person gets the command for an administrator terminal and "Check
/// again". An executor that ran is answered by its result file, as on Linux.
pub fn elevation_after_runas(prepared: &PreparedStep, started: Result<u32, i32>) -> Elevation {
    match started {
        Err(ERROR_CANCELLED) => Elevation::Declined,
        Err(_) => Elevation::Manual { command: ENABLE_WSL_MANUAL_COMMAND.to_string() },
        Ok(code) => finished(prepared, Some(code as i32), ""),
    }
}

/// The executor's command line after its path: `host-step exec "<request>"`. Windows paths never
/// contain `"`, so quoting the whole path keeps a profile folder with a space one argument.
pub fn runas_parameters(request: &Path) -> String {
    format!("host-step exec \"{}\"", request.display())
}

/// The security descriptor of a Windows request folder: owned by the user, a protected DACL (so
/// nothing is inherited from `%LOCALAPPDATA%`) granting full access to the user, `SYSTEM` and
/// `Administrators`, inherited by the request and result files. The elevated executor refuses a
/// folder anyone else may write (core `judgeWindowsAcl`).
pub fn request_folder_sddl(user_sid: &str) -> String {
    format!("O:{user_sid}D:P(A;OICI;FA;;;{user_sid})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
}

/// Wait for the result file the person's `sudo` run writes, up to `limit`.
#[cfg(unix)]
pub async fn wait_for_result(
    prepared: &PreparedStep,
    interval: Duration,
    limit: Duration,
) -> Option<(ReceiptOutcome, String)> {
    let deadline = tokio::time::Instant::now() + limit;
    loop {
        if let Some(result) = read_result(&prepared.result) {
            return Some(result);
        }
        if tokio::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(interval).await;
    }
}

fn tail(text: &str) -> String {
    let text = text.trim();
    let start = text.len().saturating_sub(2000);
    let mut start = start;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].to_string()
}

/// What every platform shares: reading a result, the receipt, and how a Windows elevation ended.
#[cfg(test)]
mod outcome_tests {
    use super::*;
    use serde_json::json;
    use std::path::Path;

    fn enable_wsl_step() -> HostStep {
        HostStep::from_operation(&json!({
            "operation_id": "op-w",
            "pending_host_step": {
                "step_id": "step-w",
                "action": "windows.enable-wsl",
                "recipe_id": "windows.enable-wsl",
                "recipe_digest": "sha256:cc",
                "parameters_digest": "sha256:dd",
                "parameters": {},
                "nonce": "n-w",
                "expected_operation_revision": 7
            }
        }))
        .expect("a pending step")
    }

    /// A request folder with the executor's result already in it, as after an elevated run.
    fn finished_step(result: Option<&str>) -> (tempfile::TempDir, PreparedStep) {
        let dir = tempfile::tempdir().unwrap();
        let prepared = PreparedStep {
            dir: dir.path().to_path_buf(),
            binary: dir.path().join("atomic-chat-core.exe"),
            request: dir.path().join("step-w.request.json"),
            result: dir.path().join("step-w.result.json"),
        };
        if let Some(result) = result {
            std::fs::write(&prepared.result, result).unwrap();
        }
        (dir, prepared)
    }

    #[test]
    fn reads_the_enable_wsl_step_with_its_empty_parameters() {
        let step = enable_wsl_step();
        assert_eq!(step.action, "windows.enable-wsl");
        assert_eq!(step.parameters, json!({}));
    }

    #[test]
    fn a_result_that_asks_for_a_reboot_is_read_as_such() {
        // Core task 2.4: `wsl --install --no-distribution` that needs a restart.
        let (_dir, prepared) = finished_step(Some(r#"{"outcome":"reboot-required","log_tail":"restart"}"#));
        assert_eq!(
            read_result(&prepared.result),
            Some((ReceiptOutcome::RebootRequired, "restart".into()))
        );
    }

    #[test]
    fn the_receipt_carries_a_reboot_required_outcome_as_the_core_spells_it() {
        let receipt = enable_wsl_step().receipt(ReceiptOutcome::RebootRequired, "r-w");
        assert_eq!(receipt["outcome"], "reboot-required");
        assert_eq!(receipt["parameters_digest"], "sha256:dd");
    }

    #[test]
    fn a_dismissed_uac_prompt_is_a_decline() {
        let (_dir, prepared) = finished_step(None);
        assert_eq!(elevation_after_runas(&prepared, Err(ERROR_CANCELLED)), Elevation::Declined);
    }

    #[test]
    fn uac_that_cannot_be_raised_hands_over_the_command_for_an_administrator_terminal() {
        // Design D15: elevation refused by policy, or no consent UI at all.
        let (_dir, prepared) = finished_step(None);
        for code in [5, 740, 1260] {
            assert_eq!(
                elevation_after_runas(&prepared, Err(code)),
                Elevation::Manual { command: "wsl --install".into() }
            );
        }
    }

    #[test]
    fn an_elevated_run_is_answered_by_its_result_file() {
        let (_dir, prepared) = finished_step(Some(r#"{"outcome":"reboot-required","log_tail":""}"#));
        assert_eq!(
            elevation_after_runas(&prepared, Ok(0)),
            Elevation::Finished { outcome: ReceiptOutcome::RebootRequired, log_tail: String::new() }
        );
        let (_dir, prepared) = finished_step(Some(r#"{"outcome":"completed","log_tail":"enabled"}"#));
        assert_eq!(
            elevation_after_runas(&prepared, Ok(0)),
            Elevation::Finished { outcome: ReceiptOutcome::Completed, log_tail: "enabled".into() }
        );
    }

    #[test]
    fn an_elevated_run_without_a_result_is_a_failure_with_its_exit_code() {
        // Exit 2: the executor did not trust the request folder.
        let (_dir, prepared) = finished_step(None);
        match elevation_after_runas(&prepared, Ok(2)) {
            Elevation::Finished { outcome, log_tail } => {
                assert_eq!(outcome, ReceiptOutcome::Failed);
                assert!(log_tail.contains("exited with 2"), "{log_tail}");
            }
            other => panic!("expected a failure, got {other:?}"),
        }
    }

    #[test]
    fn the_request_path_is_one_quoted_argument_of_the_executor() {
        // A user profile path with a space must stay one argument of `host-step exec`.
        assert_eq!(
            runas_parameters(Path::new(r"C:\Users\Ann Lee\AppData\Local\AtomicChat\host-steps\x\s.request.json")),
            r#"host-step exec "C:\Users\Ann Lee\AppData\Local\AtomicChat\host-steps\x\s.request.json""#
        );
    }

    #[test]
    fn the_request_folder_admits_only_the_user_system_and_administrators() {
        // Owned by the user; a protected DACL, so nothing is inherited from above; full access for
        // the user, SYSTEM and Administrators, passed down to the request and result files. This is
        // exactly what the core's executor accepts (core `judgeWindowsAcl`).
        assert_eq!(
            request_folder_sddl("S-1-5-21-1-2-3-1001"),
            "O:S-1-5-21-1-2-3-1001D:P(A;OICI;FA;;;S-1-5-21-1-2-3-1001)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
        );
    }

    #[test]
    fn the_windows_executor_is_the_cli_core_exe_beside_the_app_core_exe() {
        let bin = tempfile::tempdir().unwrap();
        let app_core = bin.path().join("atomic-chat-app-core.exe");
        let cli_core = bin.path().join("atomic-chat-core.exe");
        std::fs::write(&app_core, b"").unwrap();
        std::fs::write(&cli_core, b"").unwrap();
        let command = super::super::launch::CoreCommand {
            program: app_core.to_string_lossy().into_owned(),
            prefix: Vec::new(),
            resources_dir: None,
            cloudflared_bin: None,
        };

        assert_eq!(executor_binary(&command).unwrap(), cli_core);
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use serde_json::json;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    /// A stand-in for the core binary: `host-step exec <request>` writes `result` beside the request
    /// and exits with `code`, as the real executor does (0 completed, 1 failed, 2 no result file).
    fn fake_core(dir: &Path, result: Option<&str>, code: i32) -> PathBuf {
        let write = result
            .map(|r| format!("printf '%s' '{r}' > \"${{3%.request.json}}.result.json\""))
            .unwrap_or_default();
        script(dir, "core-src", &format!("{write}\nexit {code}"))
    }

    /// `pkexec` that authorizes everything and runs the program as given.
    fn passthrough_pkexec(dir: &Path) -> PathBuf {
        script(dir, "pkexec", "exec \"$@\"")
    }

    fn step() -> HostStep {
        HostStep::from_operation(&json!({
            "operation_id": "op-1",
            "revision": 4,
            "pending_host_step": {
                "step_id": "step-1",
                "action": "linux.install-container-runtime",
                "recipe_id": "linux.install-container-runtime",
                "recipe_digest": "sha256:aa",
                "parameters_digest": "sha256:bb",
                "parameters": { "user": "ann", "arch": "x86_64", "family": "apt",
                    "distro_id": "ubuntu", "version_id": "24.04", "components": ["docker-engine"] },
                "nonce": "n-1",
                "expected_operation_revision": 4
            }
        }))
        .expect("a pending step")
    }

    fn laid_out(core: &Path) -> (tempfile::TempDir, PreparedStep) {
        let runtime = tempfile::tempdir().unwrap();
        let prepared = prepare(runtime.path(), core, &step(), Path::new("/data")).unwrap();
        (runtime, prepared)
    }

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn reads_the_step_the_core_hands_out_and_nothing_else() {
        assert_eq!(step().nonce, "n-1");
        assert_eq!(step().expected_operation_revision, 4);
        assert_eq!(HostStep::from_operation(&json!({ "operation_id": "op-1", "pending_host_step": null })), None);
    }

    #[test]
    fn lays_out_a_private_copy_of_the_core_and_a_private_request() {
        let bin = tempfile::tempdir().unwrap();
        let core = fake_core(bin.path(), None, 0);
        let (runtime, prepared) = laid_out(&core);

        assert!(prepared.dir.starts_with(runtime.path()));
        assert_eq!(mode(&prepared.dir), 0o700);
        assert_eq!(mode(&prepared.binary), 0o700);
        assert_eq!(mode(&prepared.request), 0o600);
        assert_eq!(std::fs::read(&prepared.binary).unwrap(), std::fs::read(&core).unwrap());
        assert_eq!(prepared.request.file_name().unwrap(), "step-1.request.json");
        assert_eq!(prepared.result.file_name().unwrap(), "step-1.result.json");

        let request: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&prepared.request).unwrap()).unwrap();
        assert_eq!(request["schema_version"], 1);
        assert_eq!(request["operation_id"], "op-1");
        assert_eq!(request["recipe_digest"], "sha256:aa");
        assert_eq!(request["parameters_digest"], "sha256:bb");
        assert_eq!(request["nonce"], "n-1");
        assert_eq!(request["data_folder"], "/data");
        assert_eq!(request["parameters"]["user"], "ann");

        prepared.remove();
        assert!(!prepared.dir.exists());
    }

    #[test]
    fn two_steps_never_share_a_folder() {
        let bin = tempfile::tempdir().unwrap();
        let core = fake_core(bin.path(), None, 0);
        let runtime = tempfile::tempdir().unwrap();
        let first = prepare(runtime.path(), &core, &step(), Path::new("/data")).unwrap();
        let second = prepare(runtime.path(), &core, &step(), Path::new("/data")).unwrap();
        assert_ne!(first.dir, second.dir);
    }

    #[tokio::test]
    async fn a_completed_step_is_read_from_the_result_file() {
        let bin = tempfile::tempdir().unwrap();
        let core = fake_core(bin.path(), Some(r#"{"outcome":"completed","log_tail":"installed"}"#), 0);
        let (_runtime, prepared) = laid_out(&core);

        let outcome = elevate(&passthrough_pkexec(bin.path()), &prepared).await;

        assert_eq!(
            outcome,
            Elevation::Finished { outcome: ReceiptOutcome::Completed, log_tail: "installed".into() }
        );
    }

    #[tokio::test]
    async fn a_step_the_executor_refused_is_a_failure_with_its_log() {
        let bin = tempfile::tempdir().unwrap();
        let core = fake_core(bin.path(), Some(r#"{"outcome":"failed","log_tail":"apt: no network"}"#), 1);
        let (_runtime, prepared) = laid_out(&core);

        let outcome = elevate(&passthrough_pkexec(bin.path()), &prepared).await;

        assert_eq!(
            outcome,
            Elevation::Finished { outcome: ReceiptOutcome::Failed, log_tail: "apt: no network".into() }
        );
    }

    #[tokio::test]
    async fn a_failed_step_is_named_with_its_exit_code_and_error() {
        // Manual run F-2: the person saw only "did not finish"; the result file said why.
        let bin = tempfile::tempdir().unwrap();
        let core = fake_core(
            bin.path(),
            Some(r#"{"outcome":"failed","log_tail":"docker.service: start-limit-hit","steps":[{"id":"docker-engine","status":"applied","exit_code":0,"stderr":"","detail":""},{"id":"docker-service","status":"failed","exit_code":1,"stderr":"all predefined address pools have been fully subnetted","detail":"systemctl enable --now docker"}]}"#),
            1,
        );
        let (_runtime, prepared) = laid_out(&core);

        match elevate(&passthrough_pkexec(bin.path()), &prepared).await {
            Elevation::Finished { outcome, log_tail } => {
                assert_eq!(outcome, ReceiptOutcome::Failed);
                assert!(log_tail.starts_with("docker-service failed (exit 1)"), "{log_tail}");
                assert!(log_tail.contains("fully subnetted"), "{log_tail}");
                assert!(log_tail.contains("start-limit-hit"), "{log_tail}");
            }
            other => panic!("expected a failure, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn no_result_file_is_a_failure() {
        // Exit 2: the executor did not trust the folder, or could not write its result.
        let bin = tempfile::tempdir().unwrap();
        let core = script(bin.path(), "core-src", "echo 'untrusted folder' >&2\nexit 2");
        let (_runtime, prepared) = laid_out(&core);

        match elevate(&passthrough_pkexec(bin.path()), &prepared).await {
            Elevation::Finished { outcome, log_tail } => {
                assert_eq!(outcome, ReceiptOutcome::Failed);
                assert!(log_tail.contains("untrusted folder"), "{log_tail}");
            }
            other => panic!("expected a failure, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_dismissed_prompt_is_a_decline() {
        let bin = tempfile::tempdir().unwrap();
        let (_runtime, prepared) = laid_out(&fake_core(bin.path(), None, 0));
        let pkexec = script(bin.path(), "pkexec", "exit 126");

        assert_eq!(elevate(&pkexec, &prepared).await, Elevation::Declined);
    }

    #[tokio::test]
    async fn not_being_authorized_is_a_decline() {
        let bin = tempfile::tempdir().unwrap();
        let (_runtime, prepared) = laid_out(&fake_core(bin.path(), None, 0));
        let pkexec = script(bin.path(), "pkexec", "echo 'Not authorized.' >&2\nexit 127");

        assert_eq!(elevate(&pkexec, &prepared).await, Elevation::Declined);
    }

    #[tokio::test]
    async fn without_a_polkit_agent_the_person_gets_the_exact_sudo_command() {
        let bin = tempfile::tempdir().unwrap();
        let (_runtime, prepared) = laid_out(&fake_core(bin.path(), None, 0));
        let pkexec = script(
            bin.path(),
            "pkexec",
            "echo 'Error executing command as another user: No authentication agent found.' >&2\nexit 127",
        );

        let expected = format!(
            "sudo {} host-step exec {}",
            prepared.binary.display(),
            prepared.request.display()
        );
        assert_eq!(elevate(&pkexec, &prepared).await, Elevation::Manual { command: expected });
        // The copy stays: the person is about to run it.
        assert!(prepared.binary.exists());
    }

    #[tokio::test]
    async fn without_pkexec_the_person_gets_the_exact_sudo_command() {
        let bin = tempfile::tempdir().unwrap();
        let (_runtime, prepared) = laid_out(&fake_core(bin.path(), None, 0));

        let outcome = elevate(&bin.path().join("no-such-pkexec"), &prepared).await;

        assert!(matches!(outcome, Elevation::Manual { ref command } if command.starts_with("sudo ")));
    }

    #[tokio::test]
    async fn the_result_of_a_manual_run_is_picked_up_when_it_appears() {
        let bin = tempfile::tempdir().unwrap();
        let (_runtime, prepared) = laid_out(&fake_core(bin.path(), None, 0));
        let result = prepared.result.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            std::fs::write(result, r#"{"outcome":"completed","log_tail":""}"#).unwrap();
        });

        let picked = wait_for_result(&prepared, Duration::from_millis(10), Duration::from_secs(5)).await;

        assert_eq!(picked.map(|(outcome, _)| outcome), Some(ReceiptOutcome::Completed));
    }

    #[tokio::test]
    async fn a_manual_run_that_never_happens_times_out() {
        let bin = tempfile::tempdir().unwrap();
        let (_runtime, prepared) = laid_out(&fake_core(bin.path(), None, 0));

        let picked = wait_for_result(&prepared, Duration::from_millis(5), Duration::from_millis(30)).await;

        assert_eq!(picked, None);
    }

    fn command(program: &Path, prefix: &[&str]) -> super::super::launch::CoreCommand {
        super::super::launch::CoreCommand {
            program: program.to_string_lossy().into_owned(),
            prefix: prefix.iter().map(|arg| arg.to_string()).collect(),
            resources_dir: None,
            cloudflared_bin: None,
        }
    }

    #[test]
    fn the_executor_is_the_cli_core_next_to_the_bundled_app_core() {
        // Manual run F-1: the app core accepts only `daemon`; `host-step exec` is the CLI core's.
        let bin = tempfile::tempdir().unwrap();
        let app_core = script(bin.path(), "atomic-chat-app-core", "exit 0");
        let cli_core = script(bin.path(), "atomic-chat-core", "exit 0");

        assert_eq!(executor_binary(&command(&app_core, &[])).unwrap(), cli_core);
    }

    #[test]
    fn a_local_core_build_is_paired_with_the_cli_core_built_beside_it() {
        // Manual run F-3: in Linux dev the core runs through ATOMIC_CORE_CMD from `npm run build:bin`.
        let bin = tempfile::tempdir().unwrap();
        let app_core = script(bin.path(), "atomic-chat-app-core-x86_64-unknown-linux-gnu", "exit 0");
        let cli_core = script(bin.path(), "atomic-chat-core-x86_64-unknown-linux-gnu", "exit 0");

        assert_eq!(executor_binary(&command(&app_core, &[])).unwrap(), cli_core);
    }

    #[test]
    fn a_core_without_its_cli_twin_is_named_rather_than_guessed() {
        let bin = tempfile::tempdir().unwrap();
        let app_core = script(bin.path(), "atomic-chat-app-core", "exit 0");

        let error = executor_binary(&command(&app_core, &[])).unwrap_err();
        assert!(error.contains("atomic-chat-core"), "{error}");
    }

    #[test]
    fn a_core_run_from_source_has_no_binary_to_elevate() {
        let error = executor_binary(&command(Path::new("/usr/bin/bun"), &["run", "src/app-daemon.ts"]))
            .unwrap_err();
        assert!(error.contains("ATOMIC_CORE_CMD"), "{error}");
    }

    #[test]
    fn a_step_is_elevated_once_at_a_time() {
        let first = claim("step-claim").expect("free");
        assert!(claim("step-claim").is_none(), "a second executor would race the first");
        assert!(claim("step-other").is_some());
        drop(first);
        assert!(claim("step-claim").is_some(), "free again once the first run ended");
    }

    #[test]
    fn the_receipt_names_exactly_the_step_it_answers() {
        let receipt = step().receipt(ReceiptOutcome::Declined, "r-1");

        assert_eq!(
            receipt,
            json!({
                "step_id": "step-1",
                "nonce": "n-1",
                "expected_operation_revision": 4,
                "recipe_digest": "sha256:aa",
                "parameters_digest": "sha256:bb",
                "outcome": "declined",
                "receipt_id": "r-1",
            })
        );
    }
}
