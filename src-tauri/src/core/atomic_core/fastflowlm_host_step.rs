//! FastFlowLM has its own digest-bound request/receipt protocol, separate from Docker and WSL.
use super::commands::AtomicCoreClient;
use super::fastflowlm_models::{owned, read_document, write_document};
use super::host_step::HostStep;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
#[cfg(windows)]
use tauri::Manager;
use tauri::{AppHandle, Runtime, State};

fn bound_step(operation: &Value) -> Result<HostStep, String> {
    if operation["state"] != "preparing-host" {
        return Err("FastFlowLM is not waiting for a host step.".into());
    }
    let step =
        HostStep::from_operation(operation).ok_or("Missing FastFlowLM host authorization.")?;
    if step.step_id.is_empty()
        || step.step_id.len() > 128
        || !step
            .step_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
        || !matches!(
            step.action.as_str(),
            "linux.configure-runtime-memlock" | "linux.install-amd-npu" | "windows.install-amd-npu"
        )
    {
        return Err("Invalid FastFlowLM host step.".into());
    }
    Ok(step)
}
fn bound_receipt(operation: &Value, result: &Value) -> Result<Value, String> {
    let step = bound_step(operation)?;
    let pending = &operation["pending_host_step"];
    if result["schema_version"] != 1
        || result.get("error_code") != Some(&Value::Null)
        || result["operation_id"] != operation["operation_id"]
        || [
            "step_id",
            "nonce",
            "expected_operation_revision",
            "recipe_id",
            "recipe_digest",
            "parameters_digest",
        ]
        .iter()
        .any(|key| result[*key] != pending[*key])
        || !result["log_tail"].is_string()
    {
        return Err("The FastFlowLM receipt does not match this authorization.".into());
    }
    let windows = step.action == "windows.install-amd-npu";
    let code = result["exit_code"].as_i64();
    let valid = match result["outcome"].as_str() {
        Some("completed") => code == Some(0),
        Some("failed") => result["exit_code"].is_null() || code.is_some_and(|c| c != 0),
        Some("declined") => windows && code == Some(1223),
        Some("reboot-required") => code == Some(if windows { 3010 } else { 0 }),
        Some("relogin-required") => !windows && code == Some(0),
        Some("service-restart-required") => {
            !windows
                && code == Some(0)
                && result["activation"]["kind"] == "restart-service"
                && step.parameters["runtime_service"].is_string()
                && result["activation"]["unit"] == step.parameters["runtime_service"]
                && result["activation"]["account"] == step.parameters["runtime_account"]
                && result["activation"]["scope"]
                    == if step.parameters["runtime_mode"] == "user-service" {
                        json!("user")
                    } else {
                        json!("system")
                    }
        }
        _ => false,
    };
    if !valid {
        return Err("Invalid FastFlowLM host outcome.".into());
    }
    let log = result["log_tail"].as_str().unwrap_or("");
    let tail: String = log
        .chars()
        .rev()
        .take(16384)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    let mut receipt = step.receipt(
        super::host_step::ReceiptOutcome::Completed,
        &format!("atomic-app-{}", step.step_id),
    );
    receipt["outcome"] = result["outcome"].clone();
    receipt["log_tail"] = json!(tail);
    Ok(receipt)
}
async fn call(
    client: &AtomicCoreClient,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    client
        .call(method, path, body)
        .await
        .map_err(|e| format!("{}: {}", e.code, e.message))
}

async fn submit_result(
    client: &AtomicCoreClient,
    base: &str,
    op: &Value,
    path: &Path,
) -> Result<Option<Value>, String> {
    if !path.exists() {
        return Ok(None);
    }
    if std::fs::metadata(path).map_err(|e| e.to_string())?.len() > 1024 * 1024 {
        return Err("Oversized FastFlowLM host receipt.".into());
    }
    let result = read_document(path)
        .await?
        .ok_or("Missing FastFlowLM host receipt.")?;
    let receipt = bound_receipt(op, &result)?;
    match call(
        client,
        "POST",
        &format!("{base}/host-step-receipt"),
        Some(receipt),
    )
    .await
    {
        Ok(op) => Ok(Some(op)),
        Err(e) => {
            let current = call(client, "GET", base, None).await?;
            if current["pending_host_step"]["step_id"] != op["pending_host_step"]["step_id"] {
                Ok(Some(current))
            } else {
                Err(e)
            }
        }
    }
}

fn failed_result(op: &Value, code: i64, message: &str) -> Value {
    let mut result = op["pending_host_step"].clone();
    result["schema_version"] = json!(1);
    result["operation_id"] = op["operation_id"].clone();
    result["error_code"] = Value::Null;
    result["log_tail"] = json!(message);
    result["exit_code"] = json!(code);
    result["outcome"] = json!(if code == 1223
        && op["pending_host_step"]["action"] == "windows.install-amd-npu"
    {
        "declined"
    } else {
        "failed"
    });
    result
}
fn journal_path(root: &Path, op: &Value) -> Result<PathBuf, String> {
    let step = bound_step(op)?;
    Ok(root.join(format!("{}-{}.json", step.operation_id, step.step_id)))
}

#[tauri::command]
pub async fn atomic_fastflowlm_run_host_step<R: Runtime>(
    app: AppHandle<R>,
    client: State<'_, AtomicCoreClient>,
    operation_id: String,
) -> Result<Value, String> {
    if operation_id.is_empty()
        || operation_id.len() > 128
        || !operation_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(&c))
    {
        return Err("Invalid FastFlowLM operation ID.".into());
    }
    let _claim = super::host_step::claim(&format!("fastflowlm-host:{operation_id}"))
        .ok_or("FastFlowLM system authorization is already running.")?;
    let base = format!("/runtimes/fastflowlm/operations/{operation_id}");
    let mut op = call(&client, "GET", &base, None).await?;
    if op["state"] != "preparing-host" {
        return Ok(op);
    }
    let root = client
        .supervisor()
        .data_folder()
        .canonicalize()
        .map_err(|e| e.to_string())?
        .join("fastflowlm/host-steps");
    owned(&root)?;
    if !op["pending_host_step"].is_null() {
        let journal = journal_path(&root, &op)?;
        if let Some(saved) = read_document(&journal).await? {
            if saved["operation"]["pending_host_step"] != op["pending_host_step"] {
                return Err("The FastFlowLM host authorization changed.".into());
            }
            let result = PathBuf::from(
                saved["result"]
                    .as_str()
                    .ok_or("Invalid FastFlowLM recovery journal.")?,
            );
            if let Some(done) = submit_result(&client, &base, &op, &result).await? {
                return Ok(done);
            }
            if let Some(pending) = pending_authorization(&op, &result).await? {
                return Ok(pending);
            }
            return Err("The FastFlowLM helper result is unknown. Wait for system authorization to finish; after a reboot, resume the same preparation. The helper was not launched again.".into());
        }
    }
    // A claimed snapshot without a local launch record cannot authorize a second invocation.
    if !op["pending_host_step"].is_null() {
        return Err("This FastFlowLM step was already claimed. Recover its original helper result or reboot before resuming.".into());
    }
    if op["reason"] == "cancellation-requested" {
        return Ok(op);
    }
    // Definite preflight failures leave the authorization unclaimed and retryable.
    let binary = super::commands::host_step_executor(&app).map_err(|e| e.message)?;
    #[cfg(unix)]
    if !cfg!(target_os = "linux")
        || std::env::var_os("XDG_RUNTIME_DIR").map_or(true, |dir| !PathBuf::from(dir).is_dir())
    {
        return Err("FastFlowLM system authorization requires a Linux runtime directory.".into());
    }
    write_document(
        &root.join(format!("{operation_id}.intent.json")),
        &json!({"operation_id":operation_id,"expected_revision":op["revision"]}),
    )
    .await?;
    op = call(
        &client,
        "POST",
        &format!("{base}/claim-host-step"),
        Some(json!({"expected_revision":op["revision"]})),
    )
    .await?;
    let step = bound_step(&op)?;
    if op["revision"].as_u64() != Some(step.expected_operation_revision) {
        return Err("Stale FastFlowLM host authorization.".into());
    }
    let journal = journal_path(&root, &op)?;
    let preparation=async {
        let prepared=prepare(&app,&binary,&step,client.supervisor().data_folder())?;
        let mut request=step.request(client.supervisor().data_folder(),0);request.as_object_mut().unwrap().remove("requested_at");
        write_document(&prepared.request,&request).await?;
        let sha=format!("{:x}",Sha256::digest(request.to_string().as_bytes()));
        write_document(&journal,&json!({"operation":op,"result":prepared.result,"request":prepared.request,"sha256":sha})).await?;
        Ok::<_,String>((prepared,sha))
    }.await;
    let (prepared, sha) = match preparation {
        Ok(result) => result,
        Err(error) => {
            let receipt = bound_receipt(&op, &failed_result(&op, -1, &error))?;
            return call(
                &client,
                "POST",
                &format!("{base}/host-step-receipt"),
                Some(receipt),
            )
            .await;
        }
    };
    // Persist intent before elevation; after any uncertain outcome recovery reads only the receipt.
    let refused = launch(&prepared, &sha, &op).await?;
    if let Some((code, message)) = refused {
        let result = failed_result(&op, code, &message);
        write_document(&prepared.result, &result).await?;
    }
    if let Some(done) = submit_result(&client, &base, &op, &prepared.result).await? {
        return Ok(done);
    }
    pending_authorization(&op, &prepared.result)
        .await?
        .ok_or("FastFlowLM helper returned no receipt; its launch will not be repeated.".into())
}

fn prepare<R: Runtime>(
    app: &AppHandle<R>,
    binary: &Path,
    step: &HostStep,
    data: &Path,
) -> Result<super::host_step::PreparedStep, String> {
    #[cfg(unix)]
    {
        let _ = app;
        let runtime = std::env::var_os("XDG_RUNTIME_DIR")
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .ok_or("A runtime directory is required for FastFlowLM system authorization.")?;
        super::host_step::prepare(&runtime, binary, step, data).map_err(|e| e.to_string())
    }
    #[cfg(windows)]
    {
        let root = app
            .path()
            .app_local_data_dir()
            .map_err(|e| e.to_string())?
            .join("fastflowlm-host-steps");
        super::host_step_windows::prepare(&root, binary, step, data).map_err(|e| e.to_string())
    }
}
// Native-only guidance; core snapshots remain authoritative about readiness.
async fn pending_authorization(op: &Value, result: &Path) -> Result<Option<Value>, String> {
    let Some(dir) = result.parent() else {
        return Ok(None);
    };
    let Some(prompt) = read_document(&dir.join("authorization.json")).await? else {
        return Ok(None);
    };
    let mut pending = op.clone();
    pending["desktop_host_step"] = prompt;
    Ok(Some(pending))
}

#[cfg(unix)]
#[derive(Debug, PartialEq)]
enum LinuxAuthorization {
    Terminal,
    Polkit,
    Manual,
}
#[cfg(unix)]
fn linux_authorization(
    display: bool,
    terminal: bool,
    sudo: bool,
    polkit: bool,
) -> Result<LinuxAuthorization, String> {
    if display && terminal && sudo {
        Ok(LinuxAuthorization::Terminal)
    } else if display && polkit {
        Ok(LinuxAuthorization::Polkit)
    } else if sudo {
        Ok(LinuxAuthorization::Manual)
    } else {
        Err("No system authorization is available. Install sudo or a polkit authentication agent, then resume preparation.".into())
    }
}
#[cfg(unix)]
fn executable(name: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(name))
        .find(|path| {
            std::fs::metadata(path)
                .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        })
}
#[cfg(unix)]
const TERMINAL_SCRIPT: &str = r#"#!/bin/sh
# Only this unprivileged wrapper owns the terminal; sudo runs the bound core helper.
umask 077
[ -f "$6" ] && exit 0
mkdir "$7" 2>/dev/null || exit 0
trap ':' HUP INT TERM
printf '%s\n' 'Atomic Chat: authorize the approved FastFlowLM system changes.'
"$1" -k -- "$2" host-step exec "$3" --request-sha256 "$4"
# sudo refusal has no helper receipt. A hard link publishes a bound failure without
# overwriting a receipt already written by the privileged helper.
ln "$5" "$6" 2>/dev/null || :
"#;
#[cfg(unix)]
fn terminal_arguments(
    prepared: &super::host_step::PreparedStep,
    sudo: &Path,
    sha: &str,
) -> Vec<std::ffi::OsString> {
    [
        PathBuf::from("--"),
        PathBuf::from("/bin/sh"),
        prepared.dir.join("authorize.sh"),
        sudo.to_path_buf(),
        prepared.binary.clone(),
        prepared.request.clone(),
        PathBuf::from(sha),
        prepared.dir.join("authorization-failed.json"),
        prepared.result.clone(),
        prepared.dir.join("authorization-started"),
    ]
    .into_iter()
    .map(PathBuf::into_os_string)
    .collect()
}
#[cfg(unix)]
fn quote_argument(value: &std::ffi::OsStr) -> String {
    format!("'{}'", value.to_string_lossy().replace('\'', "'\\''"))
}
#[cfg(unix)]
async fn publish_authorization(
    prepared: &super::host_step::PreparedStep,
    args: &[std::ffi::OsString],
    kind: &str,
) -> Result<(), String> {
    // Drop xdg-terminal-exec's separator: the manual command starts with /bin/sh.
    let command = args[1..]
        .iter()
        .map(|arg| quote_argument(arg))
        .collect::<Vec<_>>()
        .join(" ");
    write_document(
        &prepared.dir.join("authorization.json"),
        &json!({"kind":kind,"command":command}),
    )
    .await
}

async fn launch(
    prepared: &super::host_step::PreparedStep,
    sha: &str,
    op: &Value,
) -> Result<Option<(i64, String)>, String> {
    #[cfg(unix)]
    {
        if !cfg!(target_os = "linux") {
            return Err("FastFlowLM preparation is available on Windows and Linux only.".into());
        }
        let sudo = executable("sudo");
        let terminal = executable("xdg-terminal-exec");
        let polkit = executable("pkexec");
        let display = ["DISPLAY", "WAYLAND_DISPLAY"]
            .iter()
            .any(|key| std::env::var_os(key).is_some_and(|value| !value.is_empty()));
        let strategy = match linux_authorization(
            display,
            terminal.is_some(),
            sudo.is_some(),
            polkit.is_some(),
        ) {
            Ok(strategy) => strategy,
            Err(error) => return Ok(Some((-1, error))),
        };
        let terminal_args = if let Some(sudo) = &sudo {
            let script = prepared.dir.join("authorize.sh");
            std::fs::write(&script, TERMINAL_SCRIPT).map_err(|e| e.to_string())?;
            write_document(&prepared.dir.join("authorization-failed.json"),
                &failed_result(op, -1, "Terminal authorization ended without a helper receipt. Resume preparation to review a new authorization.")).await?;
            terminal_arguments(prepared, sudo, sha)
        } else {
            Vec::new()
        };
        if strategy != LinuxAuthorization::Polkit {
            let kind = if strategy == LinuxAuthorization::Terminal {
                "terminal"
            } else {
                "manual"
            };
            publish_authorization(prepared, &terminal_args, kind).await?;
            if strategy == LinuxAuthorization::Manual {
                return Ok(None);
            }
            // A successful launcher may detach immediately. Only a receipt can complete the step.
            let status = tokio::process::Command::new(terminal.as_ref().unwrap())
                .args(&terminal_args)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .await;
            return match status {
                Ok(status) if status.success() || prepared.result.exists() => Ok(None),
                // A launcher can fail after opening a terminal; offer the guarded same command.
                _ => {
                    publish_authorization(prepared, &terminal_args, "manual").await?;
                    Ok(None)
                }
            };
        }
        let process = tokio::process::Command::new(polkit.as_ref().unwrap())
            .arg(&prepared.binary)
            .args(["host-step", "exec"])
            .arg(&prepared.request)
            .arg("--request-sha256")
            .arg(sha)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn();
        let child = match process {
            Ok(child) => child,
            Err(e) => {
                return Ok(Some((
                    -1,
                    format!("Could not start system authorization: {e}"),
                )))
            }
        };
        let output = child
            .wait_with_output()
            .await
            .map_err(|e| format!("System authorization result is unknown: {e}"))?;
        if prepared.result.exists() {
            return Ok(None);
        }
        if sudo.is_some()
            && String::from_utf8_lossy(&output.stderr).contains("No authentication agent")
        {
            publish_authorization(prepared, &terminal_args, "manual").await?;
            return Ok(None);
        }
        Ok(Some((
            output
                .status
                .code()
                .map(i64::from)
                .filter(|c| *c != 0)
                .unwrap_or(-1),
            String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(16384)
                .collect(),
        )))
    }
    #[cfg(windows)]
    {
        let _ = op;
        let binary = prepared.binary.clone();
        let request = prepared.request.clone();
        let sha = sha.to_string();
        let code = tauri::async_runtime::spawn_blocking(move || {
            super::host_step_windows::run_as_administrator(
                &binary,
                &format!(
                    "host-step exec \"{}\" --request-sha256 {sha}",
                    request.display()
                ),
                &mut || {},
            )
        })
        .await
        .map_err(|e| e.to_string())?;
        if prepared.result.exists() {
            return Ok(None);
        }
        Ok(Some((
            match code {
                Ok(c) => i64::from(c),
                Err(c) => i64::from(c),
            },
            "Windows system authorization returned no helper receipt.".into(),
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn operation() -> Value {
        json!({"operation_id":"op-1","revision":3,"state":"preparing-host","pending_host_step":{"step_id":"step-1","action":"linux.configure-runtime-memlock","recipe_id":"memlock","recipe_digest":"sha256:aa","parameters_digest":"sha256:bb","nonce":"nonce-1","expected_operation_revision":3,"parameters":{"runtime_account":"atomic","runtime_service":null,"runtime_mode":"desktop"}}})
    }
    fn result(op: &Value) -> Value {
        let mut r = op["pending_host_step"].clone();
        r["operation_id"] = op["operation_id"].clone();
        r["schema_version"] = json!(1);
        r["error_code"] = Value::Null;
        r["outcome"] = json!("completed");
        r["exit_code"] = json!(0);
        r["log_tail"] = json!("");
        r
    }
    #[cfg(unix)]
    #[test]
    fn fastflowlm_handoff_authorization_prefers_terminal_and_survives_missing_polkit() {
        assert_eq!(
            linux_authorization(true, true, true, true).unwrap(),
            LinuxAuthorization::Terminal
        );
        assert_eq!(
            linux_authorization(true, true, true, false).unwrap(),
            LinuxAuthorization::Terminal
        );
        assert_eq!(
            linux_authorization(true, false, true, true).unwrap(),
            LinuxAuthorization::Polkit
        );
        assert_eq!(
            linux_authorization(true, false, true, false).unwrap(),
            LinuxAuthorization::Manual
        );
        assert_eq!(
            linux_authorization(false, true, true, true).unwrap(),
            LinuxAuthorization::Manual
        );
        assert!(linux_authorization(true, false, false, false).is_err());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn fastflowlm_handoff_terminal_preserves_binding_failure_receipt_and_one_launch() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let dir = root
            .path()
            .canonicalize()
            .unwrap()
            .join("space ' $(touch injected)");
        std::fs::create_dir(&dir).unwrap();
        let prepared = super::super::host_step::PreparedStep {
            binary: dir.join("atomic-chat-core"),
            request: dir.join("step-1.request.json"),
            result: dir.join("step-1.result.json"),
            dir: dir.clone(),
        };
        let sudo = dir.join("fake-sudo");
        std::fs::write(
            &sudo,
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$0.args\"\nexit 1\n",
        )
        .unwrap();
        std::fs::set_permissions(&sudo, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(dir.join("authorize.sh"), TERMINAL_SCRIPT).unwrap();
        let failure = failed_result(&operation(), -1, "Authorization refused");
        write_document(&dir.join("authorization-failed.json"), &failure)
            .await
            .unwrap();
        let sha = "a".repeat(64);
        let args = terminal_arguments(&prepared, &sudo, &sha);
        let run = || {
            std::process::Command::new(&args[1])
                .args(&args[2..])
                .current_dir(&dir)
                .output()
                .unwrap()
        };
        assert!(run().status.success());
        assert_eq!(
            read_document(&prepared.result).await.unwrap().unwrap(),
            failure
        );
        assert_eq!(
            bound_receipt(&operation(), &failure).unwrap()["outcome"],
            "failed"
        );
        let invocation = std::fs::read_to_string(sudo.with_file_name("fake-sudo.args")).unwrap();
        assert_eq!(
            invocation.lines().collect::<Vec<_>>(),
            vec![
                "-k",
                "--",
                prepared.binary.to_str().unwrap(),
                "host-step",
                "exec",
                prepared.request.to_str().unwrap(),
                "--request-sha256",
                &sha
            ]
        );
        assert!(!dir.join("injected").exists());
        // A second invocation cannot run sudo, even if the first receipt is lost.
        std::fs::remove_file(&prepared.result).unwrap();
        assert!(run().status.success());
        assert!(!prepared.result.exists());
        assert_eq!(
            std::fs::read_to_string(sudo.with_file_name("fake-sudo.args")).unwrap(),
            invocation
        );
        publish_authorization(&prepared, &args, "manual")
            .await
            .unwrap();
        let pending = pending_authorization(&operation(), &prepared.result)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(pending["state"], "preparing-host");
        assert_eq!(pending["desktop_host_step"]["kind"], "manual");
        assert!(pending["desktop_host_step"]["command"]
            .as_str()
            .unwrap()
            .contains(&sha));
        assert_eq!(
            quote_argument(std::ffi::OsStr::new("it's literal")),
            "'it'\\''s literal'"
        );
    }
    #[cfg(unix)]
    #[test]
    fn fastflowlm_handoff_terminal_never_overwrites_a_helper_receipt() {
        let root = tempfile::tempdir().unwrap();
        let prepared = super::super::host_step::PreparedStep {
            dir: root.path().to_path_buf(),
            binary: root.path().join("core"),
            request: root.path().join("request"),
            result: root.path().join("result"),
        };
        std::fs::write(prepared.dir.join("authorize.sh"), TERMINAL_SCRIPT).unwrap();
        std::fs::write(&prepared.result, "original helper receipt").unwrap();
        let args = terminal_arguments(
            &prepared,
            Path::new("/does-not-exist/sudo"),
            &"a".repeat(64),
        );
        assert!(std::process::Command::new(&args[1])
            .args(&args[2..])
            .status()
            .unwrap()
            .success());
        assert_eq!(
            std::fs::read_to_string(&prepared.result).unwrap(),
            "original helper receipt"
        );
    }
    #[test]
    fn fastflowlm_host_rejects_replayed_receipts_and_path_step_ids() {
        let op = operation();
        let mut r = result(&op);
        r["nonce"] = json!("another-step");
        assert!(bound_receipt(&op, &r).is_err());
        let mut op = op;
        op["pending_host_step"]["step_id"] = json!("../escape");
        assert!(bound_step(&op).is_err());
    }
    #[test]
    fn fastflowlm_host_preserves_service_restart_instead_of_completing_it() {
        let op = operation();
        let mut r = result(&op);
        r["outcome"] = json!("service-restart-required");
        assert!(bound_receipt(&op, &r).is_err());
        let mut op = op;
        op["pending_host_step"]["parameters"]["runtime_service"] = json!("atomic.service");
        op["pending_host_step"]["parameters"]["runtime_mode"] = json!("system-service");
        let mut r = result(&op);
        r["outcome"] = json!("service-restart-required");
        r["activation"] = json!({"kind":"restart-service","unit":"atomic.service","account":"atomic","scope":"system"});
        assert_eq!(
            bound_receipt(&op, &r).unwrap()["outcome"],
            "service-restart-required"
        );
    }
    #[test]
    fn fastflowlm_host_retry_uses_a_new_step_journal_and_bound_failure() {
        let op = operation();
        let first = journal_path(Path::new("/steps"), &op).unwrap();
        let mut retry = op.clone();
        retry["pending_host_step"]["step_id"] = json!("step-2");
        assert_ne!(first, journal_path(Path::new("/steps"), &retry).unwrap());
        let failed = failed_result(&retry, -1, "Could not launch authorization");
        assert_eq!(bound_receipt(&retry, &failed).unwrap()["outcome"], "failed");
        assert!(bound_receipt(&op, &failed).is_err());
    }
}
