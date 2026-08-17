use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tauri::{Manager, Runtime, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, Mutex};
use tokio::time::Instant;

use crate::error::{ErrorCode, MlxError, ServerError, ServerResult};
use crate::process::{
    find_session_by_model_id, get_all_active_sessions, get_all_loaded_model_ids,
    get_random_available_port, is_process_running_by_pid,
};
use crate::state::{MlxBackendSession, MlxState, SessionInfo};

#[cfg(unix)]
use crate::process::graceful_terminate_process;

#[derive(serde::Serialize, serde::Deserialize)]
pub struct UnloadResult {
    success: bool,
    error: Option<String>,
}

/// Diagnose why the mlx-server child exited and log a precise, actionable line.
///
/// The mlx-server (PyInstaller onefile) has a slow, silent startup. When it
/// dies before emitting a readiness signal we need to know whether it crashed
/// *in-process* (it printed something to stderr) or was terminated by an
/// *external signal* (empty stderr + a signal exit status such as SIGKILL/9).
/// The latter points at an outside killer — OS OOM, code-signing/Gatekeeper,
/// or something in the app tearing the process down — not an mlx-vlm bug.
fn log_mlx_exit(phase: &str, status: std::process::ExitStatus, stderr_output: &str) {
    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt;
        status.signal()
    };
    #[cfg(not(unix))]
    let signal: Option<i32> = None;

    // One failure, one report. These used to be three separate `error!` calls,
    // which the Sentry log bridge filed as three issues for the same exit — and
    // because the raw `ExitStatus` was in the headline, each distinct status
    // code split off yet another group. The diagnosis is the same event, so it
    // is logged as one, with a stable headline and the details in the body.
    let diagnosis = if let Some(sig) = signal {
        format!(
            "terminated by signal {sig} (9 = SIGKILL, 15 = SIGTERM) — an EXTERNAL \
             process killed it, it did not crash on its own"
        )
    } else if stderr_output.trim().is_empty() {
        "produced NO stderr before exiting — the signature of an external kill \
         (SIGKILL/OOM/Gatekeeper), not an in-process crash. Check \
         `log show --predicate 'sender == \"kernel\"'` for OOM/codesign, and \
         `codesign -dv` on the mlx-server binary."
            .to_string()
    } else {
        "exited on its own".to_string()
    };

    log::error!(
        "MLX server exited during {phase}: {diagnosis}\nstatus: {status:?}\nstderr:\n{}",
        if stderr_output.trim().is_empty() {
            "<empty>"
        } else {
            stderr_output
        }
    );
}

/// MLX server configuration passed from the frontend
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MlxConfig {
    #[serde(default)]
    pub ctx_size: i32,
    #[serde(default)]
    pub draft_model_path: String,
    #[serde(default)]
    pub block_size: i32,
    /// Drafter family — "dflash" (default), "mtp" (Gemma 4 assistant +
    /// Qwen / DeepSeek-V4 MTP heads) or "eagle3" (Gemma 4 speculator).
    /// Empty string is treated as "dflash" so pre-update callers keep
    /// working without churn. The value is passed verbatim to mlx-vlm's
    /// `--draft-kind` (choices: dflash | eagle3 | mtp); mlx-vlm also
    /// auto-corrects it from the drafter's HF `model_type` if it disagrees.
    #[serde(default)]
    pub draft_kind: String,
    /// KV-cache quantization bit-width (e.g. 3.5 for TurboQuant). `0.0`
    /// (default) disables quantization. Emitted as `--kv-bits` only when
    /// `> 0.0` and `kv_quant_scheme` selects a real scheme.
    #[serde(default)]
    pub kv_bits: f32,
    /// KV-cache quantization scheme — "" / "off" (no quantization, default),
    /// "uniform" or "turboquant". When a real scheme is set together with a
    /// positive `kv_bits`, both are passed to mlx-vlm as `--kv-quant-scheme`
    /// + `--kv-bits`; otherwise the server stays on its un-quantized default.
    #[serde(default)]
    pub kv_quant_scheme: String,
}

fn normalize_mlx_model_path(path: &str) -> String {
    let path_buf = PathBuf::from(path);
    if path_buf.is_file() {
        path_buf
            .parent()
            .map(|parent| parent.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string())
    } else {
        path.to_string()
    }
}

fn build_mlx_server_args(model_path: &str, port: u16, config: &MlxConfig) -> Vec<String> {
    let mut args = vec![
        "--model".to_string(),
        normalize_mlx_model_path(model_path),
        "--host".to_string(),
        "127.0.0.1".to_string(),
        "--port".to_string(),
        port.to_string(),
    ];

    if config.ctx_size > 0 {
        args.push("--max-kv-size".to_string());
        args.push(config.ctx_size.to_string());
    }

    if !config.draft_model_path.is_empty() {
        args.push("--draft-model".to_string());
        args.push(normalize_mlx_model_path(&config.draft_model_path));
        let kind = match config.draft_kind.as_str() {
            "dflash" | "mtp" | "eagle3" => config.draft_kind.as_str(),
            _ => "dflash",
        };
        args.push("--draft-kind".to_string());
        args.push(kind.to_string());

        if config.block_size > 0 {
            args.push("--draft-block-size".to_string());
            args.push(config.block_size.to_string());
        }
    }

    if matches!(config.kv_quant_scheme.as_str(), "uniform" | "turboquant") && config.kv_bits > 0.0 {
        args.push("--kv-bits".to_string());
        args.push(config.kv_bits.to_string());
        args.push("--kv-quant-scheme".to_string());
        args.push(config.kv_quant_scheme.clone());
    }

    args
}

/// Core model-loading logic, decoupled from Tauri AppHandle.
/// `binary_path` must point to the mlx-server executable.
/// `process_map_arc` is the shared session map from MlxState.
pub async fn load_mlx_model_impl(
    process_map_arc: Arc<Mutex<HashMap<i32, MlxBackendSession>>>,
    load_operation: Arc<Mutex<()>>,
    binary_path: &Path,
    model_id: String,
    model_path: String,
    port: u16,
    config: MlxConfig,
    envs: HashMap<String, String>,
    is_embedding: bool,
    timeout: u64,
) -> ServerResult<SessionInfo> {
    let _load_guard = load_operation.lock().await;

    log::info!("Attempting to launch MLX server at path: {:?}", binary_path);
    log::info!("Using MLX configuration: {:?}", config);

    // Validate binary path
    let bin_path = PathBuf::from(binary_path);
    if !bin_path.exists() {
        return Err(MlxError::new(
            ErrorCode::BinaryNotFound,
            format!("MLX server binary not found at: {}", binary_path.display()),
            None,
        )
        .into());
    }

    // Validate model path
    let model_path_pb = PathBuf::from(&model_path);
    if !model_path_pb.exists() {
        return Err(MlxError::new(
            ErrorCode::ModelFileNotFound,
            format!("Model file not found at: {}", model_path),
            None,
        )
        .into());
    }

    let model_dir_arg = normalize_mlx_model_path(&model_path);
    if model_dir_arg != model_path {
        log::info!(
            "Resolving MLX model directory: {} -> {}",
            model_path,
            model_dir_arg
        );
    }

    // Build command arguments for `mlx_vlm.server` (Atomic-Chat fork at
    // AtomicBot-ai/mlx-vlm). The server binds to loopback only and runs
    // without any auth layer — there is no equivalent of `MLX_API_KEY`
    // upstream, so we drop it entirely and rely on the host filter.
    //
    // Config-key translation (TS-side names → mlx-vlm CLI flags):
    //   * `ctx_size`   → `--max-kv-size`
    //   * `block_size` → `--draft-block-size`
    //   * `draft_model_path` non-empty → `--draft-model ... --draft-kind <kind>`
    //   * `draft_kind` selects mlx-vlm's drafter family ("dflash", "mtp" or
    //     "eagle3"); empty string falls back to "dflash" so legacy callers
    //     (and stale persisted configs) keep working.
    //   * `kv_quant_scheme` ("uniform" | "turboquant") + `kv_bits` (> 0) →
    //     `--kv-quant-scheme ... --kv-bits ...` (KV-cache quantization,
    //     incl. TurboQuant). Any other scheme / non-positive bits leaves the
    //     server on its un-quantized default.
    // Keeping the TS-side names stable avoids churning the extension /
    // settings.json schema and the autoIncreaseCtx test suite.
    let args = build_mlx_server_args(&model_path, port, &config);

    log::info!("MLX server arguments: {:?}", args);

    // Configure the command
    let mut command = Command::new(&bin_path);
    command.args(&args);
    command.envs(envs);
    // Tell our mlx-vlm fork to lock onto the preloaded model and ignore
    // arbitrary `model` labels in incoming chat-completion bodies. Without
    // this the server would unload + try to fetch the requested label from
    // HF (e.g. `gemma-4-e4b-it-4bit`), which 401s for non-existent repos.
    // See `mlx_vlm/server.py::get_cached_model` (Atomic-Chat fork patch).
    command.env("MLX_VLM_SINGLE_MODEL", "1");
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    // Kill the spawned mlx-server if this load future is dropped before the
    // child is handed off to the tracked session map (e.g. a rapid model switch
    // supersedes/cancels an in-flight load). Without this, tokio leaves the
    // process running untracked, so cleanup can never reap it and orphaned
    // mlx-server instances pile up. Once inserted into the map the child is
    // owned there (not dropped), so healthy sessions keep running normally.
    command.kill_on_drop(true);

    // Spawn the child process
    let mut child = command.spawn().map_err(ServerError::Io)?;

    let stderr = child.stderr.take().expect("stderr was piped");
    let stdout = child.stdout.take().expect("stdout was piped");

    // Create channels for communication between tasks
    let (ready_tx, mut ready_rx) = mpsc::channel::<bool>(1);

    // Spawn task to monitor stdout for readiness
    let stdout_ready_tx = ready_tx.clone();
    let _stdout_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        let mut byte_buffer = Vec::new();

        loop {
            byte_buffer.clear();
            match reader.read_until(b'\n', &mut byte_buffer).await {
                Ok(0) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&byte_buffer);
                    let line = line.trim_end();
                    if !line.is_empty() {
                        log::info!("[mlx stdout] {}", line);
                    }

                    let line_lower = line.to_lowercase();
                    // Recognise readiness logs from both the legacy dflash
                    // server (Starlette) and the new mlx-vlm server (FastAPI
                    // + uvicorn). Uvicorn writes "Uvicorn running on ..."
                    // once the lifespan startup has completed.
                    if line_lower.contains("uvicorn running on")
                        || line_lower.contains("application startup complete")
                        || line_lower.contains("http server listening")
                        || line_lower.contains("server is listening")
                        || line_lower.contains("server started")
                        || line_lower.contains("ready to accept")
                        || line_lower.contains("server started and listening on")
                    {
                        log::info!("MLX server appears to be ready based on stdout: '{}'", line);
                        let _ = stdout_ready_tx.send(true).await;
                    }
                }
                Err(e) => {
                    log::error!("Error reading MLX stdout: {}", e);
                    break;
                }
            }
        }
    });

    // Spawn task to capture stderr and monitor for errors
    let stderr_task = tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut byte_buffer = Vec::new();
        let mut stderr_buffer = String::new();

        loop {
            byte_buffer.clear();
            match reader.read_until(b'\n', &mut byte_buffer).await {
                Ok(0) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&byte_buffer);
                    let line = line.trim_end();

                    if !line.is_empty() {
                        stderr_buffer.push_str(line);
                        stderr_buffer.push('\n');
                        log::info!("[mlx] {}", line);

                        let line_lower = line.to_lowercase();
                        // Same dual-format recognition as on stdout — uvicorn
                        // prints its readiness message on stderr by default.
                        if line_lower.contains("uvicorn running on")
                            || line_lower.contains("application startup complete")
                            || line_lower.contains("server is listening")
                            || line_lower.contains("server listening on")
                            || line_lower.contains("server started and listening on")
                        {
                            log::info!("MLX model appears to be ready based on logs: '{}'", line);
                            let _ = ready_tx.send(true).await;
                        }
                    }
                }
                Err(e) => {
                    log::error!("Error reading MLX logs: {}", e);
                    break;
                }
            }
        }

        stderr_buffer
    });

    // Check if process exited early
    if let Some(status) = child.try_wait()? {
        if !status.success() {
            let stderr_output = stderr_task.await.unwrap_or_default();
            log_mlx_exit("early startup", status, &stderr_output);
            return Err(MlxError::from_stderr(&stderr_output).into());
        }
    }

    // Wait for server to be ready or timeout
    let timeout_duration = Duration::from_secs(timeout);
    let start_time = Instant::now();
    log::info!("Waiting for MLX model session to be ready...");

    loop {
        tokio::select! {
            Some(true) = ready_rx.recv() => {
                log::info!("MLX model is ready to accept requests!");
                break;
            }
            _ = tokio::time::sleep(Duration::from_millis(50)) => {
                if let Some(status) = child.try_wait()? {
                    let stderr_output = stderr_task.await.unwrap_or_default();
                    if !status.success() {
                        log_mlx_exit("while waiting for ready", status, &stderr_output);
                        return Err(MlxError::from_stderr(&stderr_output).into());
                    } else {
                        // One event, not two: see `log_mlx_exit`.
                        log::error!(
                            "MLX server exited successfully but without ready signal\nstderr:\n{}",
                            stderr_output
                        );
                        return Err(MlxError::from_stderr(&stderr_output).into());
                    }
                }

                if start_time.elapsed() > timeout_duration {
                    log::error!("Timeout waiting for MLX server to be ready");
                    let _ = child.kill().await;
                    let stderr_output = stderr_task.await.unwrap_or_default();
                    return Err(MlxError::new(
                        ErrorCode::ModelLoadTimedOut,
                        "The MLX model took too long to load and timed out.".into(),
                        Some(format!(
                            "Timeout: {}s\n\nStderr:\n{}",
                            timeout_duration.as_secs(),
                            stderr_output
                        )),
                    )
                    .into());
                }
            }
        }
    }

    let pid = child.id().map(|id| id as i32).unwrap_or(-1);

    log::info!("MLX server process started with PID: {} and is ready", pid);
    // `api_key` is retained on `SessionInfo` for ABI compatibility with TS
    // consumers (always empty — mlx-vlm has no auth layer).
    //
    // `model_path` is exposed as the *directory* that was passed to
    // `--model`. Clients use this string as the OpenAI `model` field in
    // outgoing chat-completion requests so mlx-vlm's path-based cache
    // (`get_cached_model`) matches and skips the unload+reload+HF fetch
    // dance for legacy `model_id`-style request bodies.
    let session_info = SessionInfo {
        pid,
        port: port.into(),
        model_id,
        model_path: model_dir_arg,
        is_embedding,
        api_key: String::new(),
    };

    process_map_arc.lock().await.insert(
        pid,
        MlxBackendSession {
            child,
            info: session_info.clone(),
        },
    );

    Ok(session_info)
}

/// Load a model using the MLX server binary (Tauri command wrapper)
#[tauri::command]
pub async fn load_mlx_model<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    model_id: String,
    model_path: String,
    port: u16,
    config: MlxConfig,
    envs: HashMap<String, String>,
    is_embedding: bool,
    timeout: u64,
) -> ServerResult<SessionInfo> {
    let state: State<MlxState> = app_handle.state();
    let binary_path = app_handle
        .path()
        .resource_dir()
        .map_err(|e| {
            MlxError::new(
                ErrorCode::BinaryNotFound,
                "Failed to get resource dir".to_string(),
                Some(e.to_string()),
            )
        })?
        .join("resources/bin/mlx-server");
    load_mlx_model_impl(
        state.mlx_server_process.clone(),
        state.load_operation.clone(),
        &binary_path,
        model_id,
        model_path,
        port,
        config,
        envs,
        is_embedding,
        timeout,
    )
    .await
}

/// Unload an MLX model by terminating its process
#[tauri::command]
pub async fn unload_mlx_model<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    pid: i32,
) -> ServerResult<UnloadResult> {
    let state: State<MlxState> = app_handle.state();
    let session = state.mlx_server_process.lock().await.remove(&pid);

    if let Some(session) = session {
        let mut child = session.child;

        #[cfg(unix)]
        {
            graceful_terminate_process(&mut child).await;
        }

        Ok(UnloadResult {
            success: true,
            error: None,
        })
    } else {
        log::warn!("No MLX server with PID '{}' found", pid);
        Ok(UnloadResult {
            success: true,
            error: None,
        })
    }
}

/// Check if a process is still running
#[tauri::command]
pub async fn is_mlx_process_running<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    pid: i32,
) -> Result<bool, String> {
    is_process_running_by_pid(app_handle, pid).await
}

/// Get a random available port
#[tauri::command]
pub async fn get_mlx_random_port<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<u16, String> {
    get_random_available_port(app_handle).await
}

/// Find session information by model ID
#[tauri::command]
pub async fn find_mlx_session_by_model<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    model_id: String,
) -> Result<Option<SessionInfo>, String> {
    find_session_by_model_id(app_handle, &model_id).await
}

/// Get all loaded model IDs
#[tauri::command]
pub async fn get_mlx_loaded_models<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<Vec<String>, String> {
    get_all_loaded_model_ids(app_handle).await
}

/// Get all active sessions
#[tauri::command]
pub async fn get_mlx_all_sessions<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<Vec<SessionInfo>, String> {
    get_all_active_sessions(app_handle).await
}

#[derive(serde::Serialize)]
pub struct MlxServerVersion {
    pub version: String,
    pub backend: String,
}

#[tauri::command]
pub fn get_mlx_server_version<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<MlxServerVersion, String> {
    let res_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {e}"))?;

    let bin_dir = res_dir.join("resources/bin");

    let version = std::fs::read_to_string(bin_dir.join("mlx-server-version.txt"))
        .unwrap_or_default()
        .trim()
        .to_string();

    let backend = std::fs::read_to_string(bin_dir.join("mlx-server-backend.txt"))
        .unwrap_or_else(|_| "macos-arm64".to_string())
        .trim()
        .to_string();

    Ok(MlxServerVersion { version, backend })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_config() -> MlxConfig {
        MlxConfig {
            ctx_size: 0,
            draft_model_path: String::new(),
            block_size: 0,
            draft_kind: String::new(),
            kv_bits: 0.0,
            kv_quant_scheme: String::new(),
        }
    }

    fn arg_value<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
        args.iter()
            .position(|arg| arg == flag)
            .and_then(|index| args.get(index + 1))
            .map(String::as_str)
    }

    #[test]
    fn mlx_args_bind_loopback_and_translate_context_size() {
        let config = MlxConfig {
            ctx_size: 32_768,
            ..base_config()
        };

        let args = build_mlx_server_args("/models/target", 19_091, &config);

        assert_eq!(arg_value(&args, "--model"), Some("/models/target"));
        assert_eq!(arg_value(&args, "--host"), Some("127.0.0.1"));
        assert_eq!(arg_value(&args, "--port"), Some("19091"));
        assert_eq!(arg_value(&args, "--max-kv-size"), Some("32768"));
    }

    #[test]
    fn mlx_args_normalize_legacy_safetensors_path_to_model_directory() {
        let root = std::env::temp_dir().join(format!(
            "atomic-chat-mlx-args-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let shard = root.join("model.safetensors");
        std::fs::write(&shard, b"fixture").unwrap();

        let args = build_mlx_server_args(shard.to_string_lossy().as_ref(), 19_091, &base_config());
        let expected_model_dir = root.to_string_lossy();

        assert_eq!(
            arg_value(&args, "--model"),
            Some(expected_model_dir.as_ref())
        );

        std::fs::remove_file(shard).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn mlx_args_emit_each_supported_drafter_family() {
        for kind in ["dflash", "mtp", "eagle3"] {
            let draft_path = format!("repo/{kind}");
            let config = MlxConfig {
                draft_model_path: draft_path.clone(),
                block_size: 8,
                draft_kind: kind.to_string(),
                ..base_config()
            };

            let args = build_mlx_server_args("/models/target", 19_091, &config);

            assert_eq!(arg_value(&args, "--draft-model"), Some(draft_path.as_str()));
            assert_eq!(arg_value(&args, "--draft-kind"), Some(kind));
            assert_eq!(arg_value(&args, "--draft-block-size"), Some("8"));
        }
    }

    #[test]
    fn mlx_args_do_not_emit_orphan_draft_flags() {
        let config = MlxConfig {
            block_size: 8,
            draft_kind: "mtp".to_string(),
            ..base_config()
        };

        let args = build_mlx_server_args("/models/target", 19_091, &config);

        assert!(!args.iter().any(|arg| arg == "--draft-model"));
        assert!(!args.iter().any(|arg| arg == "--draft-kind"));
        assert!(!args.iter().any(|arg| arg == "--draft-block-size"));
    }

    #[test]
    fn mlx_args_default_unknown_drafter_to_legacy_dflash() {
        let config = MlxConfig {
            draft_model_path: "repo/draft".to_string(),
            draft_kind: "unknown".to_string(),
            ..base_config()
        };

        let args = build_mlx_server_args("/models/target", 19_091, &config);

        assert_eq!(arg_value(&args, "--draft-kind"), Some("dflash"));
    }

    #[test]
    fn mlx_args_emit_only_complete_supported_kv_quantization_pairs() {
        for (scheme, bits, expected) in [
            ("uniform", 8.0, true),
            ("turboquant", 3.5, true),
            ("off", 3.5, false),
            ("unknown", 3.5, false),
            ("turboquant", 0.0, false),
            ("uniform", -1.0, false),
        ] {
            let config = MlxConfig {
                kv_bits: bits,
                kv_quant_scheme: scheme.to_string(),
                ..base_config()
            };

            let args = build_mlx_server_args("/models/target", 19_091, &config);

            assert_eq!(
                args.iter().any(|arg| arg == "--kv-bits"),
                expected,
                "scheme={scheme}, bits={bits}"
            );
            assert_eq!(
                args.iter().any(|arg| arg == "--kv-quant-scheme"),
                expected,
                "scheme={scheme}, bits={bits}"
            );
            if expected {
                let expected_bits = bits.to_string();
                assert_eq!(arg_value(&args, "--kv-quant-scheme"), Some(scheme));
                assert_eq!(arg_value(&args, "--kv-bits"), Some(expected_bits.as_str()));
            }
        }
    }

    #[tokio::test]
    async fn early_load_error_does_not_wait_for_session_map_lock() {
        let binary_path = std::env::temp_dir().join(format!(
            "atomic-chat-mlx-existing-binary-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&binary_path, []).unwrap();

        let sessions = Arc::new(Mutex::new(HashMap::new()));
        let load_operation = Arc::new(Mutex::new(()));
        let _sessions_guard = sessions.lock().await;

        let result = tokio::time::timeout(
            Duration::from_millis(100),
            load_mlx_model_impl(
                sessions.clone(),
                load_operation,
                &binary_path,
                "test-model".to_string(),
                "/nonexistent/atomic-chat-mlx-model".to_string(),
                1337,
                base_config(),
                HashMap::new(),
                false,
                1,
            ),
        )
        .await;

        std::fs::remove_file(binary_path).unwrap();

        assert!(
            result.is_ok(),
            "early validation waited for the session map"
        );
        assert!(matches!(
            result.unwrap(),
            Err(ServerError::Mlx(MlxError {
                code: ErrorCode::ModelFileNotFound,
                ..
            }))
        ));
    }

    #[tokio::test]
    async fn missing_binary_is_classified_before_waiting_for_session_map() {
        let model_dir = std::env::temp_dir().join(format!(
            "atomic-chat-mlx-existing-model-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&model_dir).unwrap();

        let sessions = Arc::new(Mutex::new(HashMap::new()));
        let load_operation = Arc::new(Mutex::new(()));
        let _sessions_guard = sessions.lock().await;

        let result = tokio::time::timeout(
            Duration::from_millis(100),
            load_mlx_model_impl(
                sessions.clone(),
                load_operation,
                Path::new("/nonexistent/atomic-chat-mlx-server"),
                "test-model".to_string(),
                model_dir.display().to_string(),
                1337,
                base_config(),
                HashMap::new(),
                false,
                1,
            ),
        )
        .await;

        std::fs::remove_dir_all(model_dir).unwrap();

        assert!(
            result.is_ok(),
            "binary validation waited for the session map"
        );
        assert!(matches!(
            result.unwrap(),
            Err(ServerError::Mlx(MlxError {
                code: ErrorCode::BinaryNotFound,
                ..
            }))
        ));
    }
}
