use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tauri::{Manager, Runtime, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::time::Instant;

use crate::error::{ErrorCode, FoundationModelsError, ServerError, ServerResult};
use crate::process::{find_active_session, get_random_available_port, is_process_running_by_pid};
use crate::state::{FoundationModelsBackendSession, FoundationModelsState, SessionInfo};

#[cfg(unix)]
use crate::process::graceful_terminate_process;

#[derive(serde::Serialize, serde::Deserialize)]
pub struct UnloadResult {
    pub success: bool,
    pub error: Option<String>,
}

/// Severity a line written to the server's stderr actually carries.
///
/// The Foundation Models server logs through swift-log, which sends *every*
/// level to stderr — including the "Server started and listening" notice it
/// prints on a healthy launch. Logging the stream wholesale at `error!` turned
/// each of those into a Sentry event, so a successful startup was the single
/// most reported "crash" in the desktop project.
///
/// Lines whose level we cannot read are treated as warnings rather than errors:
/// output on stderr is not by itself a failure, and a real one is still caught
/// by the process exit status.
fn stderr_line_level(line: &str) -> log::Level {
    // `2026-08-17T12:36:50+1000 info Hummingbird: [HummingbirdCore] Server started…`
    // The level is the token right after the timestamp, but scan the first few
    // words rather than fixing a position, since not every line is stamped.
    for token in line.split_whitespace().take(3) {
        match token.trim_matches(|c: char| !c.is_ascii_alphabetic()) {
            t if t.eq_ignore_ascii_case("critical") => return log::Level::Error,
            t if t.eq_ignore_ascii_case("error") => return log::Level::Error,
            t if t.eq_ignore_ascii_case("warning") || t.eq_ignore_ascii_case("warn") => {
                return log::Level::Warn
            }
            t if t.eq_ignore_ascii_case("notice") || t.eq_ignore_ascii_case("info") => {
                return log::Level::Info
            }
            t if t.eq_ignore_ascii_case("debug") || t.eq_ignore_ascii_case("trace") => {
                return log::Level::Debug
            }
            _ => {}
        }
    }
    log::Level::Warn
}

/// Start the Foundation Models server binary.
///
/// The binary is located at `binary_path` and is started with
/// the given `port` and optional `api_key`. Success is detected
/// by watching stdout for the ready signal within `timeout` seconds.
pub async fn load_foundation_models_server_impl(
    sessions_arc: std::sync::Arc<tokio::sync::Mutex<HashMap<i32, FoundationModelsBackendSession>>>,
    binary_path: &Path,
    model_id: String,
    port: u16,
    api_key: String,
    timeout: u64,
) -> ServerResult<SessionInfo> {
    let bin_path = PathBuf::from(binary_path);
    if !bin_path.exists() {
        return Err(FoundationModelsError::new(
            ErrorCode::BinaryNotFound,
            format!(
                "foundation-models-server binary not found at: {}",
                binary_path.display()
            ),
            None,
        )
        .into());
    }

    let mut args = vec!["--port".to_string(), port.to_string()];
    if !api_key.is_empty() {
        args.push("--api-key".to_string());
        args.push(api_key.clone());
    }

    log::info!(
        "Launching Foundation Models server: {:?} {:?}",
        bin_path,
        args
    );

    let mut child = tokio::process::Command::new(&bin_path)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| ServerError::Io(e))?;

    let pid = child.id().unwrap_or(0) as i32;
    let stdout = child.stdout.take().expect("stdout not captured");
    let stderr = child.stderr.take().expect("stderr not captured");

    // Watch stderr for error messages
    let (stderr_tx, mut stderr_rx) = tokio::sync::mpsc::channel::<String>(64);
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            log::log!(
                stderr_line_level(&line),
                "[foundation-models stderr] {}",
                line
            );
            let _ = stderr_tx.send(line).await;
        }
    });

    // Watch stdout for the readiness signal
    let (ready_tx, mut ready_rx) = tokio::sync::mpsc::channel::<bool>(1);
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            log::info!("[foundation-models] {}", line);
            if line.contains("server is listening on") || line.contains("http server listening") {
                let _ = ready_tx.send(true).await;
            }
        }
    });

    let deadline = Instant::now() + Duration::from_secs(timeout);

    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => {
                log::error!("Foundation Models server startup timed out after {}s", timeout);
                // Terminate the process
                #[cfg(unix)]
                graceful_terminate_process(&mut child).await;
                #[cfg(not(unix))]
                let _ = child.kill().await;

                return Err(FoundationModelsError::new(
                    ErrorCode::ServerStartTimedOut,
                    format!(
                        "Foundation Models server did not become ready within {} seconds.",
                        timeout
                    ),
                    None,
                )
                .into());
            }

            ready = ready_rx.recv() => {
                if ready == Some(true) {
                    log::info!("Foundation Models server ready on port {}", port);
                    let session_info = SessionInfo {
                        pid,
                        port: port as i32,
                        model_id: model_id.clone(),
                        api_key: api_key.clone(),
                    };
                    let backend_session = FoundationModelsBackendSession {
                        child,
                        info: session_info.clone(),
                    };
                    sessions_arc.lock().await.insert(pid, backend_session);
                    return Ok(session_info);
                }
            }

            stderr_line = stderr_rx.recv() => {
                if let Some(line) = stderr_line {
                    if line.contains("[foundation-models] ERROR:") {
                        // The availability check failed; terminate immediately
                        #[cfg(unix)]
                        graceful_terminate_process(&mut child).await;
                        #[cfg(not(unix))]
                        let _ = child.kill().await;

                        return Err(FoundationModelsError::from_stderr(&line).into());
                    }
                }
            }

            status = child.wait() => {
                // Process exited prematurely
                let code = match status {
                    Ok(s) => s.code().unwrap_or(-1),
                    Err(_) => -1,
                };
                log::error!("Foundation Models server exited prematurely with code {}", code);
                return Err(FoundationModelsError::new(
                    ErrorCode::ServerStartFailed,
                    format!(
                        "Foundation Models server exited with code {} before becoming ready. \
                         Ensure Apple Intelligence is enabled in System Settings.",
                        code
                    ),
                    None,
                )
                .into());
            }
        }
    }
}

// ─── Tauri commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn load_foundation_models_server<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    model_id: String,
    port: u16,
    api_key: String,
    timeout: u64,
) -> Result<SessionInfo, ServerError> {
    let state: State<FoundationModelsState> = app_handle.state();

    let resource_dir = app_handle
        .path()
        .resource_dir()
        .map_err(ServerError::Tauri)?;
    let binary_path = resource_dir.join("resources/bin/foundation-models-server");

    load_foundation_models_server_impl(
        state.sessions.clone(),
        &binary_path,
        model_id,
        port,
        api_key,
        timeout,
    )
    .await
}

#[tauri::command]
pub async fn unload_foundation_models_server<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    pid: i32,
) -> Result<UnloadResult, ServerError> {
    let state: State<FoundationModelsState> = app_handle.state();
    let mut map = state.sessions.lock().await;

    if let Some(session) = map.remove(&pid) {
        let mut child = session.child;
        #[cfg(unix)]
        graceful_terminate_process(&mut child).await;
        #[cfg(not(unix))]
        let _ = child.kill().await;

        log::info!("Successfully unloaded Foundation Models server PID {}", pid);
        Ok(UnloadResult {
            success: true,
            error: None,
        })
    } else {
        Ok(UnloadResult {
            success: false,
            error: Some(format!(
                "No active Foundation Models session found for PID {}",
                pid
            )),
        })
    }
}

#[tauri::command]
pub async fn is_foundation_models_process_running<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    pid: i32,
) -> Result<bool, String> {
    is_process_running_by_pid(app_handle, pid).await
}

#[tauri::command]
pub async fn get_foundation_models_random_port<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<u16, String> {
    get_random_available_port(app_handle).await
}

#[tauri::command]
pub async fn find_foundation_models_session<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<Option<SessionInfo>, String> {
    Ok(find_active_session(app_handle).await)
}

#[tauri::command]
pub async fn get_foundation_models_loaded<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<bool, String> {
    Ok(find_active_session(app_handle).await.is_some())
}

#[tauri::command]
pub async fn get_foundation_models_all_sessions<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<Vec<SessionInfo>, String> {
    let state: State<FoundationModelsState> = app_handle.state();
    let map = state.sessions.lock().await;
    Ok(map.values().map(|s| s.info.clone()).collect())
}

/// Run the server binary with `--check` and return a machine-readable
/// availability token: `"available"`, `"notEligible"`,
/// `"appleIntelligenceNotEnabled"`, `"modelNotReady"`, `"unavailable"`,
/// or `"binaryNotFound"` if the binary is missing.
///
/// Always returns `Ok` — the caller decides what to do with the status.
#[tauri::command]
pub async fn check_foundation_models_availability<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<String, String> {
    use std::time::{Duration, Instant};

    let state: tauri::State<crate::state::FoundationModelsState> = app_handle.state();
    {
        let cache = state.availability_cache.lock().await;
        if let Some((status, at)) = cache.as_ref() {
            if at.elapsed() < Duration::from_secs(30 * 60) {
                return Ok(status.clone());
            }
        }
    }

    let resource_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?;
    let binary_path = resource_dir.join("resources/bin/foundation-models-server");

    if !binary_path.exists() {
        return Ok("binaryNotFound".to_string());
    }

    let output = tokio::process::Command::new(&binary_path)
        .arg("--check")
        .output()
        .await
        .map_err(|e| e.to_string())?;

    let status = String::from_utf8_lossy(&output.stdout).trim().to_string();

    let resolved = if status.is_empty() {
        "unavailable".to_string()
    } else {
        status
    };

    {
        let mut cache = state.availability_cache.lock().await;
        *cache = Some((resolved.clone(), Instant::now()));
    }

    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::stderr_line_level;
    use log::Level;

    #[test]
    fn a_healthy_startup_notice_is_not_an_error() {
        // The single noisiest "crash" reported by the desktop project.
        assert_eq!(
            stderr_line_level(
                "2026-08-17T12:36:50+1000 info Hummingbird: [HummingbirdCore] \
                 Server started and listening on 127.0.0.1:3188"
            ),
            Level::Info
        );
    }

    #[test]
    fn real_failures_still_reach_the_error_channel() {
        assert_eq!(
            stderr_line_level("2026-08-17T12:36:50+1000 error Hummingbird: bind failed"),
            Level::Error
        );
        assert_eq!(
            stderr_line_level("2026-08-17T12:36:50+1000 critical Hummingbird: aborting"),
            Level::Error
        );
    }

    #[test]
    fn levels_are_matched_regardless_of_case_or_punctuation() {
        assert_eq!(stderr_line_level("[INFO] starting up"), Level::Info);
        assert_eq!(stderr_line_level("WARNING: slow disk"), Level::Warn);
    }

    #[test]
    fn an_unlabelled_line_is_a_warning_not_a_crash() {
        // stderr output on its own is not a failure; the exit status decides.
        assert_eq!(
            stderr_line_level("Traceback follows, see below"),
            Level::Warn
        );
        assert_eq!(stderr_line_level(""), Level::Warn);
    }

    #[test]
    fn a_level_word_deep_in_the_message_does_not_win() {
        // "error" appearing in prose must not re-escalate an info line.
        assert_eq!(
            stderr_line_level("2026-08-17T12:36:50+1000 info Hummingbird: no error occurred"),
            Level::Info
        );
    }
}
