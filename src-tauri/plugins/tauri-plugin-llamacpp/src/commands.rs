use base64::{engine::general_purpose, Engine as _};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tauri::{Manager, Runtime, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, Mutex};
use tokio::time::Instant;

use crate::args::{ArgumentBuilder, LlamacppConfig};
use crate::device::{get_devices_from_backend, DeviceInfo};
use crate::error::{ErrorCode, LlamacppError, ServerError, ServerResult};
use crate::path::{validate_binary_path, validate_mmproj_path, validate_model_path};
use crate::process::{
    find_session_by_model_id, get_all_active_sessions, get_all_loaded_model_ids,
    get_random_available_port, is_process_running_by_pid,
};
use crate::runtime_device::{self, RuntimeDeviceInfo};
use crate::state::{LLamaBackendSession, LlamacppState, SessionInfo};
use jan_utils::{
    add_cuda_paths, binary_requires_cuda, setup_library_path, setup_windows_process_flags,
};

#[cfg(unix)]
use crate::process::graceful_terminate_process;

#[cfg(all(windows, target_arch = "x86_64"))]
use crate::process::force_terminate_process;

type HmacSha256 = Hmac<Sha256>;

#[derive(serde::Serialize, serde::Deserialize)]
pub struct UnloadResult {
    success: bool,
    error: Option<String>,
}

/// Returns true if a llama-server log line (stdout or stderr, already
/// lowercased) indicates the HTTP server has started listening.
///
/// Upstream `ggml-org/llama.cpp` has changed the exact wording of this
/// message before without warning (e.g. commit `27c8bb4f6`, first
/// released in `b9829`, dropped "server is" from "server is listening
/// on ..." down to a bare "listening on ..."), which silently broke
/// readiness detection here and caused loads to hang for the full
/// `timeout_duration` before failing. Matching on the stable substring
/// "listening on" (present in every historical variant: "server is
/// listening on", "server listening on", "router server is listening
/// on", and the current bare "listening on") is robust to any further
/// upstream rewording of the surrounding words. `/health` is the
/// primary, wording-independent readiness signal (see the HTTP poll in
/// `load_llama_model_impl`); this log-based check is a fast, low-cost
/// complement to it and a fallback for it.
fn is_ready_log_line(line_lower: &str) -> bool {
    line_lower.contains("listening on")
        || line_lower.contains("all slots are idle")
        || line_lower.contains("starting the main loop")
        || line_lower.contains("http server listening")
}

/// Core model loading logic usable without an AppHandle (CLI / test support).
pub async fn load_llama_model_impl(
    process_map_arc: Arc<Mutex<HashMap<i32, LLamaBackendSession>>>,
    backend_path: &str,
    model_id: String,
    model_path: String,
    port: u16,
    config: LlamacppConfig,
    envs: HashMap<String, String>,
    mmproj_path: Option<String>,
    is_embedding: bool,
    timeout: u64,
) -> ServerResult<SessionInfo> {
    log::info!("Attempting to launch server at path: {:?}", backend_path);
    log::info!("Using configuration: {:?}", config);

    let bin_path = validate_binary_path(backend_path)?;

    // Build arguments using the ArgumentBuilder
    let builder = ArgumentBuilder::new(config.clone(), is_embedding)
        .map_err(|e| ServerError::InvalidArgument(e))?;

    let mut args = builder.build(&model_id, &model_path, port, mmproj_path.clone());

    log::info!("Generated arguments: {:?}", args);

    // Validate paths
    let model_path_pb = validate_model_path(&mut args)?;
    let mmproj_path_pb = validate_mmproj_path(&mut args)?;

    let mmproj_path_string = if let Some(ref _mmproj_pb) = mmproj_path_pb {
        // Find the actual mmproj path from args after validation/conversion
        if let Some(mmproj_index) = args.iter().position(|arg| arg == "--mmproj") {
            Some(args[mmproj_index + 1].clone())
        } else {
            None
        }
    } else {
        None
    };

    log::info!(
        "MMPROJ Path string: {}",
        &mmproj_path_string.as_ref().unwrap_or(&"None".to_string())
    );

    let api_key: String = envs
        .get("LLAMA_API_KEY")
        .map(|s| s.to_string())
        .unwrap_or_default();

    // Configure the command to run the server
    let mut command = Command::new(&bin_path);

    command.args(args);
    command.envs(envs);

    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    // Kill the spawned llama-server if this load future is dropped before the
    // child is handed off to the tracked `process_map` (e.g. a rapid model
    // switch or onboarding retry supersedes/cancels an in-flight load). Without
    // this, tokio leaves the process running: it never enters `process_map`, so
    // neither `stop`/`stop_all` nor `cleanup_processes` (which only act on the
    // map) can ever reap it — orphaned `llama-server` instances then pile up and
    // hold ports/RAM until the user kills them by hand. Once the child *is*
    // inserted into the map it is owned there (not dropped), so healthy sessions
    // keep running normally.
    command.kill_on_drop(true);
    setup_windows_process_flags(&mut command);

    // The startup log is the only signal that reflects which device the model
    // actually ended up on; llama.cpp splits it across stdout and stderr, so
    // both readers feed the same accumulator.
    let runtime_device = runtime_device::new_shared();

    // Try to add CUDA paths (works on both Windows and Linux)
    let cuda_found = add_cuda_paths(&mut command);

    // Optionally check if binary needs CUDA
    if !cuda_found && binary_requires_cuda(&bin_path) {
        log::warn!(
            "llama.cpp backend appears to require CUDA, but CUDA not found. Process may fail to start. Please install cuda runtime and try again!"
        );
        // A CUDA build without a CUDA runtime still starts and silently runs on
        // the CPU, so record it: the extension turns this into an actionable
        // "install the CUDA runtime" hint rather than a bare tier downgrade.
        runtime_device::mark_cuda_runtime_missing(&runtime_device);
    }

    // Add the binary's directory to library path
    setup_library_path(bin_path.parent(), &mut command);

    // Spawn the child process
    let mut child = command.spawn().map_err(ServerError::Io)?;

    let stderr = child.stderr.take().expect("stderr was piped");
    let stdout = child.stdout.take().expect("stdout was piped");

    // Create channels for communication between tasks
    let (ready_tx, mut ready_rx) = mpsc::channel::<bool>(1);

    // Spawn task to monitor stdout for readiness
    let stdout_ready_tx = ready_tx.clone();
    let stdout_runtime_device = runtime_device.clone();
    let stdout_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut byte_buffer = Vec::new();
        // Retained for error classification: llama.cpp reports loader failures
        // on stdout in several builds, leaving stderr empty on exit.
        let mut stdout_buffer = String::new();

        loop {
            byte_buffer.clear();
            match reader.read_until(b'\n', &mut byte_buffer).await {
                Ok(0) => break, // EOF
                Ok(_) => {
                    let line = String::from_utf8_lossy(&byte_buffer);
                    let line = line.trim_end();
                    if !line.is_empty() {
                        stdout_buffer.push_str(line);
                        stdout_buffer.push('\n');
                        log::info!("[llamacpp stdout] {}", line);
                        runtime_device::ingest_line(&stdout_runtime_device, line);
                    }

                    // Check for readiness indicators
                    let line_lower = line.to_lowercase();
                    if is_ready_log_line(&line_lower) {
                        log::info!("Server appears to be ready based on stdout: '{}'", line);
                        let _ = stdout_ready_tx.send(true).await;
                    }
                }
                Err(e) => {
                    log::error!("Error reading stdout: {}", e);
                    break;
                }
            }
        }

        stdout_buffer
    });

    // Spawn task to capture stderr and monitor for errors
    let stderr_ready_tx = ready_tx.clone();
    let stderr_runtime_device = runtime_device.clone();
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut byte_buffer = Vec::new();
        let mut stderr_buffer = String::new();

        loop {
            byte_buffer.clear();
            match reader.read_until(b'\n', &mut byte_buffer).await {
                Ok(0) => break, // EOF
                Ok(_) => {
                    let line = String::from_utf8_lossy(&byte_buffer);
                    let line = line.trim_end();

                    if !line.is_empty() {
                        stderr_buffer.push_str(line);
                        stderr_buffer.push('\n');
                        log::info!("[llamacpp] {}", line);
                        runtime_device::ingest_line(&stderr_runtime_device, line);

                        // Check for readiness indicator
                        let line_lower = line.to_string().to_lowercase();
                        if is_ready_log_line(&line_lower) {
                            log::info!("Model appears to be ready based on logs: '{}'", line);
                            let _ = stderr_ready_tx.send(true).await;
                        }
                    }
                }
                Err(e) => {
                    log::error!("Error reading logs: {}", e);
                    break;
                }
            }
        }

        stderr_buffer
    });

    // Poll the /health endpoint as a version-independent readiness signal,
    // complementing the log-line matchers above. Upstream has changed the
    // "listening" log wording before with no warning (see `is_ready_log_line`)
    // and could again; `/health` is a stable contract across every llama.cpp
    // version we've observed — HTTP 503 with a JSON error body while the
    // model is loading, HTTP 200 with `{"status":"ok"}` once ready — so this
    // path keeps working even if every log-based matcher above goes stale.
    let health_ready_tx = ready_tx.clone();
    let health_task: tokio::task::JoinHandle<()> = tokio::spawn(async move {
        let client = match reqwest::Client::builder()
            .timeout(Duration::from_millis(500))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                log::warn!("Failed to build health-check HTTP client: {}", e);
                return;
            }
        };
        let url = format!("http://127.0.0.1:{}/health", port);

        loop {
            tokio::time::sleep(Duration::from_millis(200)).await;
            if let Ok(resp) = client.get(&url).send().await {
                if resp.status().is_success() {
                    log::info!("Server appears to be ready based on /health check");
                    let _ = health_ready_tx.send(true).await;
                    break;
                }
            }
        }
    });

    // Check if process exited early
    if let Some(status) = child.try_wait()? {
        if !status.success() {
            health_task.abort();
            let stderr_output = stderr_task.await.unwrap_or_default();
            // WS1.1/WS3.2: warn! (not error!) so the SentryLogger bridge does not
            // raise a duplicate crash event — the structured error returned below
            // is reported once by the frontend model-load choke point — and
            // classify native crash exit codes into an actionable error.
            let stdout_output = stdout_task.await.unwrap_or_default();
            log::warn!("llama.cpp failed early with code {:?}", status);
            log::warn!("{}", stderr_output);
            return Err(
                LlamacppError::from_process_output(&status, &stderr_output, &stdout_output).into(),
            );
        }
    }

    // Wait for server to be ready or timeout
    let timeout_duration = Duration::from_secs(timeout);
    let start_time = Instant::now();
    log::info!("Waiting for model session to be ready...");

    loop {
        tokio::select! {
            // Server is ready
            Some(true) = ready_rx.recv() => {
                log::info!("Model is ready to accept requests!");
                health_task.abort();
                break;
            }
            // Check for process exit more frequently
            _ = tokio::time::sleep(Duration::from_millis(50)) => {
                // Check if process exited
                if let Some(status) = child.try_wait()? {
                    health_task.abort();
                    let stderr_output = stderr_task.await.unwrap_or_default();
                    if !status.success() {
                        // WS1.1: warn! (not error!) — the structured error returned
                        // below is reported once by the frontend choke point, so an
                        // error! here is a duplicate Sentry crash event.
                        // WS3.2: classify native crash exit codes (access violation /
                        // segfault) into an actionable, recoverable error.
                        let stdout_output = stdout_task.await.unwrap_or_default();
                        log::warn!("llama.cpp exited with error code {:?}", status);
                        return Err(LlamacppError::from_process_output(&status, &stderr_output, &stdout_output).into());
                    } else {
                        log::warn!("llama.cpp exited successfully but without ready signal");
                        return Err(LlamacppError::from_stderr(&stderr_output).into());
                    }
                }

                // Timeout check
                if start_time.elapsed() > timeout_duration {
                    log::error!("Timeout waiting for server to be ready");
                    health_task.abort();
                    let _ = child.kill().await;
                    let stderr_output = stderr_task.await.unwrap_or_default();
                    return Err(LlamacppError::new(
                        ErrorCode::ModelLoadTimedOut,
                        "The model took too long to load and timed out.".into(),
                        Some(format!("Timeout: {}s\n\nStderr:\n{}", timeout_duration.as_secs(), stderr_output)),
                    ).into());
                }
            }
        }
    }

    // Get the PID to use as session ID
    let pid = child.id().map(|id| id as i32).unwrap_or(-1);

    log::info!("Server process started with PID: {} and is ready", pid);

    let device_info = runtime_device::snapshot(&runtime_device);
    log::info!(
        "Runtime device for model '{}': backends={:?} primary={} offloaded={:?}/{:?}",
        model_id,
        device_info.loaded_backends,
        device_info.primary_device,
        device_info.gpu_layers_offloaded,
        device_info.total_layers
    );

    let session_info = SessionInfo {
        pid: pid.clone(),
        port: port.into(),
        model_id: model_id,
        model_path: model_path_pb.display().to_string(),
        is_embedding: is_embedding,
        api_key: api_key,
        mmproj_path: mmproj_path_string,
        runtime_device: if device_info.is_inconclusive() {
            None
        } else {
            Some(device_info)
        },
    };

    {
        let mut process_map = process_map_arc.lock().await;
        process_map.insert(
            pid.clone(),
            LLamaBackendSession {
                child,
                info: session_info.clone(),
                runtime_device,
            },
        );
    }

    Ok(session_info)
}

/// Load a llama model and start the server
#[tauri::command]
pub async fn load_llama_model<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    backend_path: &str,
    model_id: String,
    model_path: String,
    port: u16,
    config: LlamacppConfig,
    envs: HashMap<String, String>,
    mmproj_path: Option<String>,
    is_embedding: bool,
    timeout: u64,
) -> ServerResult<SessionInfo> {
    let state: State<LlamacppState> = app_handle.state();
    load_llama_model_impl(
        state.llama_server_process.clone(),
        backend_path,
        model_id,
        model_path,
        port,
        config,
        envs,
        mmproj_path,
        is_embedding,
        timeout,
    )
    .await
}

/// Unload a llama model by terminating its process
#[tauri::command]
pub async fn unload_llama_model<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    pid: i32,
) -> ServerResult<UnloadResult> {
    let state: State<LlamacppState> = app_handle.state();
    let mut map = state.llama_server_process.lock().await;

    if let Some(session) = map.remove(&pid) {
        let mut child = session.child;

        #[cfg(unix)]
        {
            graceful_terminate_process(&mut child).await;
        }

        #[cfg(all(windows, target_arch = "x86_64"))]
        {
            force_terminate_process(&mut child).await;
        }

        Ok(UnloadResult {
            success: true,
            error: None,
        })
    } else {
        log::warn!("No server with PID '{}' found", pid);
        Ok(UnloadResult {
            success: true,
            error: None,
        })
    }
}

/// Get available devices from the llama.cpp backend
#[tauri::command]
pub async fn get_devices(
    backend_path: &str,
    envs: HashMap<String, String>,
) -> ServerResult<Vec<DeviceInfo>> {
    get_devices_from_backend(backend_path, envs).await
}

/// Re-snapshot which device a live session actually runs on.
///
/// `load_llama_model` already returns a snapshot taken at readiness; this
/// command covers the case where the `load_tensors` lines arrive after the
/// "listening on" line. Returns `None` when no session owns that PID.
#[tauri::command]
pub async fn get_runtime_device<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    pid: i32,
) -> ServerResult<Option<RuntimeDeviceInfo>> {
    let state: State<LlamacppState> = app_handle.state();
    let map = state.llama_server_process.lock().await;
    Ok(map
        .get(&pid)
        .map(|session| runtime_device::snapshot(&session.runtime_device)))
}

/// Generate API key using HMAC-SHA256
#[tauri::command]
pub fn generate_api_key(model_id: String, api_secret: String) -> Result<String, String> {
    let mut mac = HmacSha256::new_from_slice(api_secret.as_bytes())
        .map_err(|e| format!("Invalid key length: {}", e))?;
    mac.update(model_id.as_bytes());
    let result = mac.finalize();
    let code_bytes = result.into_bytes();
    let hash = general_purpose::STANDARD.encode(code_bytes);
    Ok(hash)
}

/// Check if a process is still running
#[tauri::command]
pub async fn is_process_running<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    pid: i32,
) -> Result<bool, String> {
    is_process_running_by_pid(app_handle, pid).await
}

/// Get a random available port
#[tauri::command]
pub async fn get_random_port<R: Runtime>(app_handle: tauri::AppHandle<R>) -> Result<u16, String> {
    get_random_available_port(app_handle).await
}

/// Find session information by model ID
#[tauri::command]
pub async fn find_session_by_model<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    model_id: String,
) -> Result<Option<SessionInfo>, String> {
    find_session_by_model_id(app_handle, &model_id).await
}

/// Get all loaded model IDs
#[tauri::command]
pub async fn get_loaded_models<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<Vec<String>, String> {
    get_all_loaded_model_ids(app_handle).await
}

/// Get all active sessions
#[tauri::command]
pub async fn get_all_sessions<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<Vec<SessionInfo>, String> {
    get_all_active_sessions(app_handle).await
}

/// Get session information by model ID
#[tauri::command]
pub async fn get_session_by_model<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    model_id: String,
) -> Result<Option<SessionInfo>, String> {
    find_session_by_model_id(app_handle, &model_id).await
}
