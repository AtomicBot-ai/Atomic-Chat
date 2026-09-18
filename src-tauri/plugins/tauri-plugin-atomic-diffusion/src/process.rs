//! Spawning and supervising the `sd-server` process.
//!
//! Readiness is real: upstream loads the model *before* it binds the port, so
//! a 200 from `GET /v1/models` means the model is loaded, and a load failure
//! exits the process before listening. `/v1/models` is a stock route that
//! llama-server also answers, so the richer `/sdcpp/v1/capabilities` is
//! probed afterwards: a 404 there means the port belongs to someone else.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};

use crate::args::{build_server_args, command_summary_for_log};
use crate::error::{DiffusionError, DiffusionErrorCode, DiffusionResult};
use crate::progress::{
    classify_exit, diagnostic_tail_deque, split_records, strip_ansi, Utf8Accumulator,
};
use crate::state::{new_tail, push_tail, ServerCapabilities, ServerSpec, SharedTail, StepListener};
use jan_utils::{
    add_cuda_paths, binary_requires_cuda, generate_random_port, setup_library_path,
    setup_windows_process_flags,
};

pub const READY_PATH: &str = "/v1/models";
pub const CAPABILITIES_PATH: &str = "/sdcpp/v1/capabilities";
const READY_POLL_INTERVAL: Duration = Duration::from_millis(300);
const READY_REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
const CAPABILITIES_TIMEOUT: Duration = Duration::from_secs(5);
/// SIGTERM → this long → SIGKILL.
pub const TERMINATE_GRACE: Duration = Duration::from_secs(5);

pub const SERVER_BINARY: &str = if cfg!(windows) {
    "sd-server.exe"
} else {
    "sd-server"
};
pub const CLI_BINARY: &str = if cfg!(windows) {
    "sd-cli.exe"
} else {
    "sd-cli"
};

pub fn server_binary_path(dir: &Path) -> PathBuf {
    dir.join(SERVER_BINARY)
}

pub struct SpawnedServer {
    pub child: Child,
    pub pid: u32,
    pub port: u16,
    pub tail: SharedTail,
    pub step_listener: StepListener,
    pub drain_tasks: Vec<tokio::task::JoinHandle<()>>,
    pub capabilities: ServerCapabilities,
    pub client: reqwest::Client,
}

/// Spawn `sd-server` for `spec`, wait until it serves the model, and probe its
/// capabilities. On any failure the child is dead when this returns.
pub async fn spawn_server(spec: &ServerSpec, scratch_dir: &Path) -> DiffusionResult<SpawnedServer> {
    let bin_path = server_binary_path(&spec.binary_dir);
    if !bin_path.is_file() {
        return Err(DiffusionError::with_details(
            DiffusionErrorCode::EngineMissing,
            "The image engine is not installed.",
            format!("missing binary: {}", bin_path.display()),
        ));
    }
    std::fs::create_dir_all(scratch_dir)
        .map_err(|e| DiffusionError::io("Could not create the scratch directory.", &e))?;

    let port = generate_random_port(&HashSet::new()).map_err(|e| {
        DiffusionError::with_details(
            DiffusionErrorCode::Internal,
            "No free port for sd-server.",
            e,
        )
    })?;
    let args = build_server_args(spec, port, scratch_dir);
    log::info!(
        "[atomic-diffusion] starting sd-server: {}",
        command_summary_for_log(&args)
    );

    let mut command = Command::new(&bin_path);
    command.args(&args);
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    // If this future is dropped before the child is handed to the session,
    // the process must not outlive it.
    command.kill_on_drop(true);
    setup_windows_process_flags(&mut command);
    let cuda_found = add_cuda_paths(&mut command);
    if !cuda_found && binary_requires_cuda(&bin_path) {
        log::warn!(
            "[atomic-diffusion] sd-server appears to need CUDA but no CUDA runtime was found"
        );
    }
    setup_library_path(bin_path.parent(), &mut command);

    let mut child = command.spawn().map_err(|e| {
        DiffusionError::with_details(
            DiffusionErrorCode::ModelLoadFailed,
            "sd-server could not be started.",
            format!("{}: {e}", bin_path.display()),
        )
    })?;
    let pid = child.id().unwrap_or(0);

    let tail = new_tail();
    let step_listener: StepListener = Arc::new(std::sync::Mutex::new(None));
    let mut drain_tasks = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        drain_tasks.push(tokio::spawn(drain(
            stdout,
            tail.clone(),
            step_listener.clone(),
            "stdout",
        )));
    }
    if let Some(stderr) = child.stderr.take() {
        drain_tasks.push(tokio::spawn(drain(
            stderr,
            tail.clone(),
            step_listener.clone(),
            "stderr",
        )));
    }

    let client = reqwest::Client::builder().build().map_err(|e| {
        DiffusionError::with_details(DiffusionErrorCode::Internal, "HTTP client", e.to_string())
    })?;
    let base_url = format!("http://127.0.0.1:{port}");

    if let Err(err) = wait_ready(&mut child, &client, &base_url, spec.startup_timeout, &tail).await
    {
        terminate(&mut child).await;
        for task in &drain_tasks {
            task.abort();
        }
        return Err(err);
    }

    let capabilities = match probe_capabilities(&client, &base_url).await {
        Ok(caps) => caps,
        Err(err) => {
            terminate(&mut child).await;
            for task in &drain_tasks {
                task.abort();
            }
            return Err(err);
        }
    };

    Ok(SpawnedServer {
        child,
        pid,
        port,
        tail,
        step_listener,
        drain_tasks,
        capabilities,
        client,
    })
}

async fn wait_ready(
    child: &mut Child,
    client: &reqwest::Client,
    base_url: &str,
    timeout: Duration,
    tail: &SharedTail,
) -> DiffusionResult<()> {
    let deadline = Instant::now() + timeout;
    let url = format!("{base_url}{READY_PATH}");
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                // Give the drain tasks a moment to flush the final lines.
                tokio::time::sleep(Duration::from_millis(100)).await;
                return Err(early_exit_error(status, tail));
            }
            Ok(None) => {}
            Err(e) => {
                return Err(DiffusionError::with_details(
                    DiffusionErrorCode::Internal,
                    "Could not poll sd-server.",
                    e.to_string(),
                ))
            }
        }
        if Instant::now() >= deadline {
            let tail_text = tail
                .lock()
                .map(|guard| diagnostic_tail_deque(&guard))
                .unwrap_or_default();
            return Err(DiffusionError::with_details(
                DiffusionErrorCode::ModelLoadFailed,
                format!(
                    "The image model did not finish loading within {} seconds.",
                    timeout.as_secs()
                ),
                tail_text,
            ));
        }
        if let Ok(resp) = client.get(&url).timeout(READY_REQUEST_TIMEOUT).send().await {
            if resp.status().as_u16() == 200 {
                return Ok(());
            }
        }
        tokio::time::sleep(READY_POLL_INTERVAL).await;
    }
}

/// Exit-code / signal aware error for a server that died before it listened.
pub fn early_exit_error(status: std::process::ExitStatus, tail: &SharedTail) -> DiffusionError {
    let tail_text = tail
        .lock()
        .map(|guard| diagnostic_tail_deque(&guard))
        .unwrap_or_default();
    let code = status.code();
    let signal = exit_signal(status);
    let classified = classify_exit(&tail_text, code.or(signal.map(|s| 128 + s)));
    let (code_out, message) = match classified {
        DiffusionErrorCode::OutOfMemory => (
            DiffusionErrorCode::OutOfMemory,
            "The image model ran out of memory while loading.".to_string(),
        ),
        _ => (
            DiffusionErrorCode::ModelLoadFailed,
            match (code, signal) {
                (Some(code), _) => format!("sd-server exited with code {code} while loading."),
                (None, Some(sig)) => {
                    format!("sd-server was terminated by signal {sig} while loading.")
                }
                (None, None) => "sd-server exited while loading.".to_string(),
            },
        ),
    };
    log::warn!("[atomic-diffusion] sd-server exited early ({status:?}):\n{tail_text}");
    DiffusionError::with_details(code_out, message, tail_text)
}

pub fn exit_signal(status: std::process::ExitStatus) -> Option<i32> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        status.signal()
    }
    #[cfg(not(unix))]
    {
        let _ = status;
        None
    }
}

async fn probe_capabilities(
    client: &reqwest::Client,
    base_url: &str,
) -> DiffusionResult<ServerCapabilities> {
    let url = format!("{base_url}{CAPABILITIES_PATH}");
    let response = match client.get(&url).timeout(CAPABILITIES_TIMEOUT).send().await {
        Ok(response) => response,
        Err(err) => {
            // Some builds block in this handler; readiness was already proven.
            log::warn!("[atomic-diffusion] capabilities probe failed, assuming defaults: {err}");
            return Ok(ServerCapabilities::default());
        }
    };
    if response.status().as_u16() == 404 {
        return Err(DiffusionError::with_details(
            DiffusionErrorCode::ModelLoadFailed,
            "Another process answered on sd-server's port.",
            format!("{url} returned 404: the listener is not stable-diffusion.cpp"),
        ));
    }
    if !response.status().is_success() {
        log::warn!(
            "[atomic-diffusion] capabilities probe returned {}, assuming defaults",
            response.status()
        );
        return Ok(ServerCapabilities::default());
    }
    let body: serde_json::Value = match response.json().await {
        Ok(body) => body,
        Err(err) => {
            log::warn!("[atomic-diffusion] capabilities body was not JSON: {err}");
            return Ok(ServerCapabilities::default());
        }
    };
    Ok(parse_capabilities(&body))
}

pub fn parse_capabilities(body: &serde_json::Value) -> ServerCapabilities {
    let img_gen = body.pointer("/features_by_mode/img_gen");
    let cancel_generating = img_gen
        .and_then(|f| f.get("cancel_generating"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    ServerCapabilities {
        cancel_generating,
        img_gen_defaults: body.pointer("/defaults_by_mode/img_gen").cloned(),
    }
}

/// Drain one pipe into the tail and the active step listener. Reads raw
/// chunks (not lines) so an in-place progress redraw without a newline is
/// delivered as soon as it is flushed.
async fn drain<Rd: AsyncRead + Unpin>(
    mut reader: Rd,
    tail: SharedTail,
    listener: StepListener,
    label: &'static str,
) {
    let mut buf = [0u8; 4096];
    let mut utf8 = Utf8Accumulator::default();
    let mut pending = String::new();
    loop {
        let n = match reader.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        pending.push_str(&utf8.push(&buf[..n]));
        let (records, rest) = split_records(&pending);
        pending = rest;
        for record in records {
            deliver(&tail, &listener, label, record);
        }
    }
    pending.push_str(&utf8.finish());
    if !pending.is_empty() {
        deliver(&tail, &listener, label, pending);
    }
}

fn deliver(tail: &SharedTail, listener: &StepListener, label: &str, record: String) {
    let line = strip_ansi(&record);
    let line = line.trim_end();
    if line.is_empty() {
        return;
    }
    log::debug!("[sd-server {label}] {line}");
    push_tail(tail, line.to_string());
    if let Ok(guard) = listener.lock() {
        if let Some(sender) = guard.as_ref() {
            let _ = sender.send(line.to_string());
        }
    }
}

/// Graceful stop: SIGTERM, wait up to [`TERMINATE_GRACE`], then SIGKILL. On
/// Windows a plain kill, which is all `TerminateProcess` offers.
pub async fn terminate(child: &mut Child) {
    terminate_with_grace(child, TERMINATE_GRACE).await
}

pub async fn terminate_with_grace(child: &mut Child, grace: Duration) {
    if let Ok(Some(status)) = child.try_wait() {
        log::debug!("[atomic-diffusion] sd-server already exited: {status}");
        return;
    }
    #[cfg(unix)]
    {
        use nix::sys::signal::{kill, Signal};
        use nix::unistd::Pid;
        if let Some(raw_pid) = child.id() {
            let pid = Pid::from_raw(raw_pid as i32);
            log::info!("[atomic-diffusion] sending SIGTERM to sd-server pid {raw_pid}");
            let _ = kill(pid, Signal::SIGTERM);
            match tokio::time::timeout(grace, child.wait()).await {
                Ok(Ok(status)) => {
                    log::info!("[atomic-diffusion] sd-server exited: {status}");
                    return;
                }
                Ok(Err(e)) => log::warn!("[atomic-diffusion] wait after SIGTERM failed: {e}"),
                Err(_) => log::warn!("[atomic-diffusion] SIGTERM timed out; sending SIGKILL"),
            }
            let _ = kill(pid, Signal::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = grace;
        if let Err(e) = child.start_kill() {
            log::warn!("[atomic-diffusion] kill failed: {e}");
        }
    }
    if let Err(e) = child.wait().await {
        log::warn!("[atomic-diffusion] wait after kill failed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{
        DiffusionBackend, EngineKind, FamilyDefaults, FamilyRanges, Modality, ModelFiles,
        OffloadPolicy,
    };

    #[test]
    fn capabilities_read_cancel_generating_and_img_gen_defaults() {
        let body = serde_json::json!({
            "features_by_mode": { "img_gen": { "cancel_generating": true, "cancel_queued": true } },
            "defaults_by_mode": { "img_gen": { "width": 1024 } }
        });
        let caps = parse_capabilities(&body);
        assert!(caps.cancel_generating);
        assert_eq!(caps.img_gen_defaults.unwrap()["width"], 1024);

        let caps = parse_capabilities(&serde_json::json!({}));
        assert!(!caps.cancel_generating);
        assert!(caps.img_gen_defaults.is_none());
    }

    #[cfg(unix)]
    fn fake_spec(dir: &Path, script: &str, timeout: Duration) -> ServerSpec {
        use std::os::unix::fs::PermissionsExt;
        let bin = dir.join(SERVER_BINARY);
        std::fs::write(&bin, script).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        ServerSpec {
            binary_dir: dir.to_path_buf(),
            engine: EngineKind::SdCpp,
            backend: DiffusionBackend::Cpu,
            backend_id: "test".into(),
            tag: "test".into(),
            model_id: "m".into(),
            family: "z-image".into(),
            modality: Modality::Image,
            display_name: "m".into(),
            files: ModelFiles {
                diffusion_model: "/nonexistent.gguf".into(),
                ..Default::default()
            },
            defaults: FamilyDefaults {
                steps: 4,
                cfg_scale: 1.0,
                guidance: None,
                sampling_method: None,
                flow_shift: None,
                width: 512,
                height: 512,
            },
            ranges: FamilyRanges {
                steps: (1, 50),
                dims: (256, 2048),
                dim_multiple: 16,
            },
            offload: OffloadPolicy::None,
            threads: None,
            extra_args: Vec::new(),
            startup_timeout: timeout,
            cpu_fallback: false,
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn early_exit_is_reported_with_the_marker_lines_first() {
        let dir = tempfile::tempdir().unwrap();
        let spec = fake_spec(
            dir.path(),
            "#!/bin/sh\necho 'loading tensors'\necho \"ggml_metal: error: unsupported op 'RMS_NORM'\" >&2\necho 'GGML_ABORT' >&2\nexit 6\n",
            Duration::from_secs(10),
        );
        let err = spawn_server(&spec, &dir.path().join("scratch"))
            .await
            .err()
            .expect("the fake server exits before listening");
        assert_eq!(err.code, DiffusionErrorCode::ModelLoadFailed);
        assert!(err.message.contains("code 6"), "{}", err.message);
        let details = err.details.unwrap();
        assert!(
            details.starts_with("ggml_metal: error: unsupported op"),
            "{details}"
        );
        assert!(details.contains("GGML_ABORT"));
        assert!(crate::args::is_ggml_unsupported_op_abort(&details));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn out_of_memory_exit_is_classified() {
        let dir = tempfile::tempdir().unwrap();
        let spec = fake_spec(
            dir.path(),
            "#!/bin/sh\necho 'ggml_backend_cuda_buffer_type_alloc_buffer: failed to allocate 4096 MB'\nexit 1\n",
            Duration::from_secs(10),
        );
        let err = spawn_server(&spec, &dir.path().join("scratch"))
            .await
            .err()
            .unwrap();
        assert_eq!(err.code, DiffusionErrorCode::OutOfMemory);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn startup_timeout_kills_the_server() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("pid");
        let script = format!(
            "#!/bin/sh\necho $$ > '{}'\nexec sleep 60\n",
            pid_file.display()
        );
        let spec = fake_spec(dir.path(), &script, Duration::from_millis(1500));
        let err = spawn_server(&spec, &dir.path().join("scratch"))
            .await
            .err()
            .unwrap();
        assert_eq!(err.code, DiffusionErrorCode::ModelLoadFailed);
        assert!(
            err.message.contains("did not finish loading"),
            "{}",
            err.message
        );
        // `terminate` reaps the child before returning, so the pid it wrote
        // (if the shell got that far on a busy box) must be gone.
        let pid_text = std::fs::read_to_string(&pid_file).unwrap_or_default();
        if let Ok(pid) = pid_text.trim().parse::<i32>() {
            let alive = nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_ok();
            assert!(!alive, "sd-server survived the startup timeout");
        }
    }

    #[tokio::test]
    async fn missing_binary_is_engine_missing() {
        let dir = tempfile::tempdir().unwrap();
        let spec = ServerSpec {
            binary_dir: dir.path().to_path_buf(),
            engine: EngineKind::SdCpp,
            backend: DiffusionBackend::Cpu,
            backend_id: "test".into(),
            tag: "test".into(),
            model_id: "m".into(),
            family: "z-image".into(),
            modality: Modality::Image,
            display_name: "m".into(),
            files: ModelFiles::default(),
            defaults: FamilyDefaults {
                steps: 4,
                cfg_scale: 1.0,
                guidance: None,
                sampling_method: None,
                flow_shift: None,
                width: 512,
                height: 512,
            },
            ranges: FamilyRanges {
                steps: (1, 50),
                dims: (256, 2048),
                dim_multiple: 16,
            },
            offload: OffloadPolicy::None,
            threads: None,
            extra_args: Vec::new(),
            startup_timeout: Duration::from_secs(1),
            cpu_fallback: false,
        };
        let err = spawn_server(&spec, &dir.path().join("scratch"))
            .await
            .err()
            .unwrap();
        assert_eq!(err.code, DiffusionErrorCode::EngineMissing);
    }
}
