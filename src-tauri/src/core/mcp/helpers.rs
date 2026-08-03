use rmcp::{
    model::{ClientCapabilities, ClientInfo, Implementation, InitializeRequestParam},
    service::RunningService,
    transport::{
        streamable_http_client::StreamableHttpClientTransportConfig, SseClientTransport,
        StreamableHttpClientTransport, TokioChildProcess,
    },
    RoleClient, ServiceExt,
};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    env,
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_http::reqwest;
use tokio::{
    io::AsyncReadExt,
    process::Command,
    sync::Mutex,
    time::{sleep, timeout},
};

const MCP_STDERR_CONTEXT_MAX_BYTES: usize = 16 * 1024;

use crate::core::{
    app::commands::get_jan_data_folder_path,
    mcp::{
        constants::{default_mcp_config, DEFAULT_MCP_HANDSHAKE_TIMEOUT_SECS},
        models::{McpServerConfig, McpSettings},
    },
    state::{AppState, RunningServiceEnum, SharedMcpServers},
};
use jan_utils::{can_override_npx, can_override_uvx};

#[derive(Debug, Clone, Copy)]
pub enum ShutdownContext {
    AppExit,       // User closing app - be fast
    ManualRestart, // User restarting servers - be thorough
    FactoryReset,  // Deleting data - be very thorough
}

impl ShutdownContext {
    pub fn per_server_timeout(&self) -> Duration {
        match self {
            Self::AppExit => Duration::from_millis(500),
            Self::ManualRestart => Duration::from_secs(2),
            Self::FactoryReset => Duration::from_secs(5),
        }
    }

    pub fn overall_timeout(&self) -> Duration {
        match self {
            Self::AppExit => Duration::from_millis(1500),
            Self::ManualRestart => Duration::from_secs(5),
            Self::FactoryReset => Duration::from_secs(10),
        }
    }
}

/// Runs MCP commands by reading configuration from a JSON file and initializing servers
///
/// # Arguments
/// * `app_path` - Path to the application directory containing mcp_config.json
/// * `servers_state` - Shared state containing running MCP services
///
/// # Returns
/// * `Ok(())` if servers were initialized successfully
/// * `Err(String)` if there was an error reading config or starting servers
pub async fn run_mcp_commands<R: Runtime>(
    app: &AppHandle<R>,
    servers_state: SharedMcpServers,
) -> Result<(), String> {
    let app_path = get_jan_data_folder_path(app.clone());
    let app_path_str = app_path.to_str().unwrap().to_string();
    log::trace!(
        "Load MCP configs from {}",
        app_path_str.clone() + "/mcp_config.json"
    );
    let config_content = std::fs::read_to_string(app_path_str + "/mcp_config.json")
        .map_err(|e| format!("Failed to read config file: {e}"))?;

    let mcp_servers: serde_json::Value = serde_json::from_str(&config_content)
        .map_err(|e| format!("Failed to parse config: {e}"))?;

    // Update runtime MCP settings from config
    {
        let settings = mcp_servers
            .get("mcpSettings")
            .and_then(|value| serde_json::from_value::<McpSettings>(value.clone()).ok())
            .unwrap_or_default();

        let app_state = app.state::<AppState>();
        let mut guard = app_state.mcp_settings.lock().await;
        *guard = settings;
    }

    let server_map = mcp_servers
        .get("mcpServers")
        .and_then(Value::as_object)
        .ok_or("No mcpServers found in config")?;

    log::trace!("MCP Servers: {server_map:#?}");

    // Collect handles for initial server startup
    let mut startup_handles = Vec::new();

    for (name, config) in server_map {
        if extract_active_status(config) == Some(false) {
            log::trace!("Server {name} is not active, skipping.");
            continue;
        }

        let app_clone = app.clone();
        let servers_clone = servers_state.clone();
        let name_clone = name.clone();
        let config_clone = config.clone();

        // Spawn task for initial startup attempt
        let handle = tauri::async_runtime::spawn(async move {
            // Only wait for the initial startup attempt, not the monitoring
            let result = start_mcp_server(
                app_clone.clone(),
                servers_clone.clone(),
                name_clone.clone(),
                config_clone.clone(),
            )
            .await;

            // If initial startup failed, we still want to continue with other servers
            if let Err(e) = &result {
                log::error!("Initial startup failed for MCP server {name_clone}: {e}");
            }

            (name_clone, result)
        });

        startup_handles.push(handle);
    }

    // Wait for all initial startup attempts to complete
    let mut successful_count = 0;
    let mut failed_count = 0;

    for handle in startup_handles {
        match handle.await {
            Ok((name, result)) => match result {
                Ok(_) => {
                    log::info!("MCP server {name} initialized successfully");
                    successful_count += 1;
                }
                Err(e) => {
                    log::error!("MCP server {name} failed to initialize: {e}");
                    failed_count += 1;
                }
            },
            Err(e) => {
                log::error!("Failed to join startup task: {e}");
                failed_count += 1;
            }
        }
    }

    log::info!(
        "MCP server initialization complete: {successful_count} successful, {failed_count} failed"
    );

    Ok(())
}

/// Starts an MCP server
/// Returns the result of the first start attempt
pub async fn start_mcp_server<R: Runtime>(
    app: AppHandle<R>,
    servers_state: SharedMcpServers,
    name: String,
    config: Value,
) -> Result<(), String> {
    let app_state = app.state::<AppState>();
    let active_servers_state = app_state.mcp_active_servers.clone();
    let shutdown_in_progress = app_state.mcp_shutdown_in_progress.lock().await;
    if *shutdown_in_progress {
        return Err(format!(
            "Cannot start MCP server {name} while MCP shutdown is in progress"
        ));
    }

    // Store active server config for restart purposes
    store_active_server_config(&active_servers_state, &name, &config).await;
    let start_generation = {
        let mut generations = app_state.mcp_start_generations.lock().await;
        let generation = generations.entry(name.clone()).or_default();
        *generation = generation.wrapping_add(1);
        *generation
    };
    drop(shutdown_in_progress);

    // Try the first start attempt and return its result
    log::info!("Starting MCP server {name} (Initial attempt)");
    let first_start_result = schedule_mcp_start_task(
        app.clone(),
        servers_state.clone(),
        name.clone(),
        config.clone(),
        start_generation,
    )
    .await;

    let start_generations = app_state.mcp_start_generations.lock().await;
    if start_generations.get(&name).copied() != Some(start_generation) {
        log::info!("Ignoring superseded MCP server {name} startup result");
        return first_start_result;
    }

    match first_start_result {
        Ok(_) => {
            app_state.mcp_server_errors.lock().await.remove(&name);
            drop(start_generations);
            log::info!("MCP server {name} started successfully");
            emit_mcp_status_update_event(&app, &name);
            Ok(())
        }
        Err(e) => {
            app_state
                .mcp_server_errors
                .lock()
                .await
                .insert(name.clone(), e.clone());
            drop(start_generations);
            log::error!("Failed to start MCP server {name} on first attempt: {e}");
            emit_mcp_status_update_event(&app, &name);
            Err(e)
        }
    }
}

async fn connect_remote_mcp(
    config: &McpServerConfig,
    transport_type: &str,
) -> Result<RunningService<RoleClient, InitializeRequestParam>, String> {
    let url = config
        .url
        .as_deref()
        .filter(|url| !url.trim().is_empty())
        .ok_or_else(|| format!("MCP {transport_type} transport requires a non-empty URL"))?;
    let handshake_timeout = config
        .timeout
        .unwrap_or_else(|| Duration::from_secs(DEFAULT_MCP_HANDSHAKE_TIMEOUT_SECS));

    timeout(handshake_timeout, async {
        let client = build_remote_http_client(config, handshake_timeout)?;
        let client_info = ClientInfo {
            protocol_version: Default::default(),
            capabilities: ClientCapabilities::default(),
            client_info: Implementation {
                name: "Atomic Chat MCP Client".to_string(),
                version: env!("CARGO_PKG_VERSION").to_string(),
                title: Some("Atomic Chat".to_string()),
                website_url: None,
                icons: None,
            },
        };

        match transport_type {
            "http" => {
                let transport = StreamableHttpClientTransport::with_client(
                    client,
                    StreamableHttpClientTransportConfig {
                        uri: url.into(),
                        ..Default::default()
                    },
                );
                client_info
                    .serve(transport)
                    .await
                    .map_err(|e| format!("Streamable HTTP handshake failed: {e}"))
            }
            "sse" => {
                let transport = SseClientTransport::start_with_client(
                    client,
                    rmcp::transport::sse_client::SseClientConfig {
                        sse_endpoint: url.into(),
                        ..Default::default()
                    },
                )
                .await
                .map_err(|e| format!("SSE transport failed: {e}"))?;
                client_info
                    .serve(transport)
                    .await
                    .map_err(|e| format!("SSE handshake failed: {e}"))
            }
            other => Err(format!("Unsupported remote MCP transport '{other}'")),
        }
    })
    .await
    .map_err(|_| {
        format!(
            "{transport_type} handshake timed out after {}s",
            handshake_timeout.as_secs()
        )
    })?
}

fn build_remote_http_client(
    config: &McpServerConfig,
    connect_timeout: Duration,
) -> Result<reqwest::Client, String> {
    let mut headers = reqwest::header::HeaderMap::new();
    for (key, value) in &config.headers {
        if let Some(value) = value.as_str() {
            if let (Ok(name), Ok(value)) = (
                reqwest::header::HeaderName::from_bytes(key.as_bytes()),
                reqwest::header::HeaderValue::from_str(value),
            ) {
                headers.insert(name, value);
            }
        }
    }

    reqwest::Client::builder()
        .default_headers(headers)
        .connect_timeout(connect_timeout)
        .build()
        .map_err(|e| format!("Failed to build MCP HTTP client: {e}"))
}

pub(crate) fn append_bounded_stderr(captured: &mut VecDeque<u8>, chunk: &[u8]) {
    captured.extend(chunk);
    let excess = captured.len().saturating_sub(MCP_STDERR_CONTEXT_MAX_BYTES);
    captured.drain(..excess);
}

pub(crate) fn format_mcp_start_error(service_error: &str, stderr_context: &str) -> String {
    let stderr_context = stderr_context.trim();
    if stderr_context.is_empty() {
        service_error.to_string()
    } else {
        format!("{service_error}\nMCP server stderr (context):\n{stderr_context}")
    }
}

async fn store_running_server<R: Runtime>(
    app: &AppHandle<R>,
    servers: &SharedMcpServers,
    name: &str,
    service: RunningServiceEnum,
    start_generation: u64,
) -> bool {
    let mut servers_guard = servers.lock().await;
    let state = app.state::<AppState>();
    let start_generations = state.mcp_start_generations.lock().await;
    if start_generations.get(name).copied() != Some(start_generation) {
        return false;
    }
    let mut generations = state.mcp_server_generations.lock().await;
    let generation = generations.entry(name.to_string()).or_default();
    *generation = generation.wrapping_add(1);
    servers_guard.insert(name.to_string(), service);
    true
}

async fn remove_mcp_pid_if_matches<R: Runtime>(
    app: &AppHandle<R>,
    name: &str,
    start_generation: u64,
    pid: u32,
) {
    let state = app.state::<AppState>();
    let mut pids = state.mcp_server_pids.lock().await;
    let remove_server_entry = if let Some(server_pids) = pids.get_mut(name) {
        if server_pids.get(&start_generation).copied() == Some(pid) {
            server_pids.remove(&start_generation);
        }
        server_pids.is_empty()
    } else {
        false
    };
    if remove_server_entry {
        pids.remove(name);
    }
}

async fn schedule_mcp_start_task<R: Runtime>(
    app: tauri::AppHandle<R>,
    servers: SharedMcpServers,
    name: String,
    config: Value,
    start_generation: u64,
) -> Result<(), String> {
    let app_path = get_jan_data_folder_path(app.clone());
    let exe_path = env::current_exe().expect("Failed to get current exe path");
    let exe_parent_path = exe_path
        .parent()
        .expect("Executable must have a parent directory");
    let bin_path = exe_parent_path.to_path_buf();

    let config_params = extract_command_args(&config)
        .ok_or_else(|| format!("Failed to extract command args from config for {name}"))?;

    if matches!(
        config_params.transport_type.as_deref(),
        Some("http" | "sse")
    ) {
        let primary_transport = config_params.transport_type.as_deref().unwrap();
        let fallback_transport = if primary_transport == "http" {
            "sse"
        } else {
            "http"
        };

        let client = match connect_remote_mcp(&config_params, primary_transport).await {
            Ok(client) => {
                log::info!("MCP server {name} connected using {primary_transport} transport");
                client
            }
            Err(primary_error) => {
                log::warn!(
                    "MCP server {name} failed using {primary_transport} transport: \
                     {primary_error}; retrying with {fallback_transport}"
                );
                match connect_remote_mcp(&config_params, fallback_transport).await {
                    Ok(client) => {
                        log::info!(
                            "MCP server {name} connected using fallback \
                             {fallback_transport} transport"
                        );
                        client
                    }
                    Err(fallback_error) => {
                        return Err(format!(
                            "Failed to connect MCP server {name}: \
                             {primary_transport}: {primary_error}; \
                             {fallback_transport}: {fallback_error}"
                        ));
                    }
                }
            }
        };

        log::info!("Connected to server: {:?}", client.peer_info());
        if !store_running_server(
            &app,
            &servers,
            &name,
            RunningServiceEnum::WithInit(client),
            start_generation,
        )
        .await
        {
            return Err(format!("MCP server {name} startup was superseded"));
        }
        emit_mcp_update_event(&app, &name);
    } else {
        if let Some(transport_type) = config_params.transport_type.as_deref() {
            if transport_type != "stdio" {
                return Err(format!(
                    "Unsupported MCP transport type '{transport_type}' for server {name}"
                ));
            }
        } else if config_params.url.is_some() {
            return Err(format!(
                "MCP server {name} has a URL but no transport type; expected 'http' or 'sse'"
            ));
        }
        if config_params.command.trim().is_empty() {
            return Err(format!("MCP stdio server {name} has no command"));
        }
        if name == "Jan Browser MCP" {
            if let Some(port_str) = config_params.envs.get("BRIDGE_PORT") {
                if let Some(port_str) = port_str.as_str() {
                    if let Ok(port) = port_str.parse::<u16>() {
                        if !jan_utils::network::is_port_available(port) {
                            log::warn!("Port {} occupied, attempting cleanup", port);
                            match kill_orphaned_mcp_process_with_app(&app, port).await {
                                Ok(true) => {
                                    log::info!("Cleaned up orphaned process on port {}", port);
                                }
                                Ok(false) => {
                                    return Err(format!(
                                        "Port {} is already in use. Please close the application using this port or restart Jan.",
                                        port
                                    ));
                                }
                                Err(e) => return Err(e),
                            }
                        }
                    }
                }
            }
        }

        let mut cmd = Command::new(config_params.command.clone());
        let bun_x_path = if cfg!(windows) {
            bin_path.join("bun.exe")
        } else {
            bin_path.join("bun")
        };
        if config_params.command.clone() == "npx"
            && can_override_npx(bun_x_path.display().to_string())
        {
            let mut cache_dir = app_path.clone();
            cache_dir.push(".npx");
            cmd = Command::new(bun_x_path.display().to_string());
            cmd.arg("x");
            cmd.env("BUN_INSTALL", cache_dir.to_str().unwrap());
        }

        let uv_path = if cfg!(windows) {
            bin_path.join("uv.exe")
        } else {
            bin_path.join("uv")
        };
        if config_params.command.clone() == "uvx" && can_override_uvx(uv_path.display().to_string())
        {
            let mut cache_dir = app_path.clone();
            cache_dir.push(".uvx");
            cmd = Command::new(uv_path);
            cmd.arg("tool");
            cmd.arg("run");
            cmd.env("UV_CACHE_DIR", cache_dir.to_str().unwrap());
        }
        #[cfg(windows)]
        {
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW: prevents shell window on Windows
        }
        #[cfg(unix)]
        cmd.process_group(0);

        cmd.kill_on_drop(true);

        // ATO-164 (defense-in-depth): launch the stdio server in its configured
        // working directory so relative paths resolve there rather than the
        // app's data dir. No-op when `cwd` is unset (inherits the app CWD).
        if let Some(cwd) = config_params.cwd.as_deref() {
            cmd.current_dir(cwd);
        }

        config_params
            .args
            .iter()
            .filter_map(Value::as_str)
            .for_each(|arg| {
                cmd.arg(arg);
            });
        config_params.envs.iter().for_each(|(k, v)| {
            if let Some(v_str) = v.as_str() {
                cmd.env(k, v_str);
            }
        });

        let (process, stderr) = TokioChildProcess::builder(cmd)
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                log::error!("Failed to run command {name}: {e}");
                format!("Failed to run command {name}: {e}")
            })?;

        let process_pid = process.id();
        let app_state = app.state::<AppState>();
        let start_generations = app_state.mcp_start_generations.lock().await;
        if start_generations.get(&name).copied() != Some(start_generation) {
            drop(start_generations);
            if let Some(pid) = process_pid {
                let _ = kill_process_tree_by_pid(pid).await;
            }
            return Err(format!("MCP server {name} startup was superseded"));
        }
        if let Some(pid) = process_pid {
            log::info!("MCP server {name} spawned with PID {pid}");
            app_state
                .mcp_server_pids
                .lock()
                .await
                .entry(name.clone())
                .or_default()
                .insert(start_generation, pid);
        }
        drop(start_generations);

        let stderr_context = Arc::new(Mutex::new(VecDeque::<u8>::new()));
        let stderr_context_for_task = stderr_context.clone();
        let stderr_server_name = name.clone();
        let stderr_task = tauri::async_runtime::spawn(async move {
            let Some(mut stderr) = stderr else {
                return;
            };
            let mut chunk = [0_u8; 4096];
            loop {
                match stderr.read(&mut chunk).await {
                    Ok(0) => break,
                    Ok(size) => {
                        log::info!(
                            "MCP server {stderr_server_name} stderr: {}",
                            String::from_utf8_lossy(&chunk[..size]).trim_end()
                        );
                        let mut captured = stderr_context_for_task.lock().await;
                        append_bounded_stderr(&mut captured, &chunk[..size]);
                    }
                    Err(error) => {
                        log::warn!(
                            "Failed reading MCP server {stderr_server_name} stderr: {error}"
                        );
                        break;
                    }
                }
            }
        });

        let handshake_timeout = config_params
            .timeout
            .unwrap_or_else(|| Duration::from_secs(DEFAULT_MCP_HANDSHAKE_TIMEOUT_SECS));
        let service = match timeout(handshake_timeout, ().serve(process)).await {
            Ok(Ok(server)) => Ok(server),
            Ok(Err(error)) => Err(format!("Failed to start MCP server {name}: {error}")),
            Err(_) => Err(format!(
                "MCP server {name} handshake timed out after {}s",
                handshake_timeout.as_secs()
            )),
        };

        match service {
            Ok(server) => {
                log::trace!("Connected to server: {:#?}", server.peer_info());
                if !store_running_server(
                    &app,
                    &servers,
                    &name,
                    RunningServiceEnum::NoInit(server),
                    start_generation,
                )
                .await
                {
                    if let Some(pid) = process_pid {
                        if let Err(error) = kill_process_tree_by_pid(pid).await {
                            log::warn!("Failed to clean up superseded MCP server {name}: {error}");
                        }
                        remove_mcp_pid_if_matches(&app, &name, start_generation, pid).await;
                    }
                    return Err(format!("MCP server {name} startup was superseded"));
                }
                log::info!("Server {name} started successfully.");
            }
            Err(service_error) => {
                let _ = timeout(Duration::from_secs(1), stderr_task).await;
                let stderr_bytes = stderr_context
                    .lock()
                    .await
                    .iter()
                    .copied()
                    .collect::<Vec<_>>();
                let stderr_context = String::from_utf8_lossy(&stderr_bytes);
                let error = format_mcp_start_error(&service_error, &stderr_context);
                if let Some(pid) = process_pid {
                    if let Err(kill_error) = kill_process_tree_by_pid(pid).await {
                        log::warn!(
                            "Failed to clean up MCP server {name} process tree: {kill_error}"
                        );
                    }
                    remove_mcp_pid_if_matches(&app, &name, start_generation, pid).await;
                }
                log::error!("{error}");
                return Err(error);
            }
        }

        // Wait a short time to verify the server is stable before marking as connected
        // This prevents race conditions where the server quits immediately
        let verification_delay = Duration::from_millis(500);
        sleep(verification_delay).await;

        // Check if server is still running after the verification delay
        let server_still_running = {
            let servers_map = servers.lock().await;
            servers_map.contains_key(&name)
        };

        if !server_still_running {
            return Err(format!("MCP server {name} quit immediately after starting"));
        }

        // Create lock file for Jan Browser MCP
        if name == "Jan Browser MCP" {
            if let Some(port_str) = config_params.envs.get("BRIDGE_PORT") {
                if let Some(port_str) = port_str.as_str() {
                    if let Ok(port) = port_str.parse::<u16>() {
                        use crate::core::mcp::lockfile::create_lock_file;
                        if let Err(e) = create_lock_file(&app, port, &name) {
                            log::warn!("Failed to create lock file for port {}: {}", port, e);
                        }
                    }
                }
            }
        }

        emit_mcp_update_event(&app, &name);
    }
    Ok(())
}

fn emit_mcp_update_event<R: Runtime>(app: &AppHandle<R>, name: &str) {
    if let Err(e) = app.emit(
        "mcp-update",
        serde_json::json!({
            "server": name
        }),
    ) {
        log::error!("Failed to emit mcp-update event: {e}");
    }
}

fn emit_mcp_status_update_event<R: Runtime>(app: &AppHandle<R>, name: &str) {
    if let Err(e) = app.emit(
        "mcp-status-update",
        serde_json::json!({
            "server": name
        }),
    ) {
        log::error!("Failed to emit mcp-status-update event: {e}");
    }
}

pub fn extract_command_args(config: &Value) -> Option<McpServerConfig> {
    let obj = config.as_object()?;
    let command = obj
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let args = obj
        .get("args")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let url = obj.get("url").and_then(|u| u.as_str()).map(String::from);
    let transport_type = obj.get("type").and_then(|t| t.as_str()).map(String::from);
    let timeout = obj
        .get("timeout")
        .and_then(|t| t.as_u64())
        .map(Duration::from_secs);
    let headers = obj
        .get("headers")
        .unwrap_or(&Value::Object(serde_json::Map::new()))
        .as_object()?
        .clone();
    let envs = obj
        .get("env")
        .unwrap_or(&Value::Object(serde_json::Map::new()))
        .as_object()?
        .clone();
    let cwd = obj
        .get("cwd")
        .and_then(|c| c.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from);
    Some(McpServerConfig {
        timeout,
        transport_type,
        url,
        command,
        args,
        envs,
        headers,
        cwd,
    })
}

pub fn extract_active_status(config: &Value) -> Option<bool> {
    let obj = config.as_object()?;
    let active = obj.get("active")?.as_bool()?;
    Some(active)
}

/// Restart only servers that were previously active (like cortex restart behavior)
pub async fn restart_active_mcp_servers<R: Runtime>(
    app: &AppHandle<R>,
    servers_state: SharedMcpServers,
) -> Result<(), String> {
    let app_state = app.state::<AppState>();
    let active_servers = app_state.mcp_active_servers.lock().await;

    log::info!(
        "Restarting {} previously active MCP servers",
        active_servers.len()
    );

    for (name, config) in active_servers.iter() {
        log::info!("Restarting MCP server: {name}");

        // Start server with restart monitoring - spawn async task
        let app_clone = app.clone();
        let servers_clone = servers_state.clone();
        let name_clone = name.clone();
        let config_clone = config.clone();

        tauri::async_runtime::spawn(async move {
            let _ = start_mcp_server(app_clone, servers_clone, name_clone, config_clone).await;
        });
    }

    Ok(())
}

pub async fn kill_orphaned_mcp_process_with_app<R: Runtime>(
    app: &AppHandle<R>,
    port: u16,
) -> Result<bool, String> {
    use crate::core::mcp::lockfile::{
        check_and_cleanup_stale_lock, is_process_alive, read_lock_file,
    };

    // Check lock file first (fast path)
    if let Some(lock) = read_lock_file(app, port) {
        log::debug!("Found lock file for port {}: PID={}", port, lock.pid);

        if !is_process_alive(lock.pid) {
            log::info!("Lock file stale, process {} is dead", lock.pid);
            check_and_cleanup_stale_lock(app, port).await?;
            return Ok(true);
        }

        // Process from lock file is alive - verify it's still the MCP process
        if let Some(process_info) = jan_utils::network::get_process_info_by_pid(lock.pid) {
            if jan_utils::network::is_orphaned_mcp_process(&process_info) {
                log::info!(
                    "Lock file PID {} verified as MCP process, attempting kill",
                    lock.pid
                );
                kill_process_by_pid(lock.pid).await?;

                use crate::core::mcp::lockfile::delete_lock_file;
                delete_lock_file(app, port)?;

                tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

                if jan_utils::network::is_port_available(port) {
                    log::info!("Cleaned up orphaned process via lock file");
                    return Ok(true);
                }
            } else {
                log::warn!(
                    "Lock file PID {} is alive but NOT an MCP process (name: {}, cmd: {:?}). Lock file is stale.",
                    lock.pid,
                    process_info.name,
                    process_info.cmd
                );
                // PID reused by another process, clean up stale lock file
                check_and_cleanup_stale_lock(app, port).await?;
            }
        } else {
            log::debug!(
                "Could not get process info for PID {}, cleaning up lock file",
                lock.pid
            );
            check_and_cleanup_stale_lock(app, port).await?;
        }
    }

    // Fallback: Use lsof/netstat to find process on port
    let process_info = match jan_utils::network::find_process_using_port(port) {
        Some(info) => info,
        None => return Ok(false),
    };

    log::info!(
        "Found process on port {}: PID={}, name={}, cmd={:?}",
        port,
        process_info.pid,
        process_info.name,
        process_info.cmd
    );

    if !jan_utils::network::is_orphaned_mcp_process(&process_info) {
        log::warn!(
            "Port {} occupied by non-Jan process '{}' (PID {})",
            port,
            process_info.name,
            process_info.pid
        );
        return Err(format!(
            "Port {} is in use by another application '{}' (PID {}). Please close that application or use a different port.",
            port, process_info.name, process_info.pid
        ));
    }

    log::info!("Killing orphaned MCP process: PID {}", process_info.pid);
    kill_process_by_pid(process_info.pid).await?;

    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

    if jan_utils::network::is_port_available(port) {
        log::info!("Cleaned up orphaned process on port {}", port);
        Ok(true)
    } else {
        Err(format!("Port {} still in use after killing process", port))
    }
}

#[cfg(unix)]
async fn kill_process_by_pid(pid: u32) -> Result<(), String> {
    use nix::sys::signal::{kill, Signal};
    use nix::unistd::Pid;

    let nix_pid = Pid::from_raw(pid as i32);

    kill(nix_pid, Signal::SIGTERM)
        .map_err(|e| format!("Failed to send SIGTERM to PID {}: {}", pid, e))?;

    for _ in 0..30 {
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        if kill(nix_pid, None).is_err() {
            return Ok(());
        }
    }

    log::warn!("Process {} unresponsive, sending SIGKILL", pid);
    kill(nix_pid, Signal::SIGKILL)
        .map_err(|e| format!("Failed to send SIGKILL to PID {}: {}", pid, e))?;

    Ok(())
}

#[cfg(windows)]
async fn kill_process_by_pid(pid: u32) -> Result<(), String> {
    use std::process::Command;

    #[cfg(windows)]
    use std::os::windows::process::CommandExt;

    let mut cmd = Command::new("taskkill");
    cmd.args(&["/F", "/T", "/PID", &pid.to_string()]);

    #[cfg(windows)]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run taskkill: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("taskkill failed: {}", stderr));
    }

    Ok(())
}

#[cfg(unix)]
pub(crate) async fn kill_process_tree_by_pid(pid: u32) -> Result<(), String> {
    use nix::errno::Errno;
    use nix::sys::signal::{kill, Signal};
    use nix::unistd::Pid;

    let process_group = Pid::from_raw(-(pid as i32));
    match kill(process_group, Signal::SIGTERM) {
        Ok(()) | Err(Errno::ESRCH) => {}
        Err(error) => {
            return Err(format!(
                "Failed to send SIGTERM to process group {pid}: {error}"
            ))
        }
    }

    for _ in 0..30 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if kill(process_group, None).is_err() {
            return Ok(());
        }
    }

    log::warn!("MCP process group {pid} unresponsive, sending SIGKILL");
    match kill(process_group, Signal::SIGKILL) {
        Ok(()) | Err(Errno::ESRCH) => Ok(()),
        Err(error) => Err(format!(
            "Failed to send SIGKILL to process group {pid}: {error}"
        )),
    }
}

#[cfg(windows)]
pub(crate) async fn kill_process_tree_by_pid(pid: u32) -> Result<(), String> {
    kill_process_by_pid(pid).await
}

pub async fn background_cleanup_mcp_servers<R: Runtime>(
    app: &AppHandle<R>,
    state: &State<'_, AppState>,
) {
    let _ = stop_mcp_servers_with_context(app, state, ShutdownContext::AppExit).await;

    // Clear active servers and restart counts
    {
        let mut active_servers = state.mcp_active_servers.lock().await;
        active_servers.clear();
    }

    // Clean up all lock files created by this process
    use crate::core::mcp::lockfile::cleanup_own_locks;
    let _ = cleanup_own_locks(app);
}

struct ShutdownGuard {
    flag: Arc<Mutex<bool>>,
}

impl Drop for ShutdownGuard {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.flag.try_lock() {
            *guard = false;
        } else {
            let flag = self.flag.clone();
            tauri::async_runtime::spawn(async move {
                let mut guard = flag.lock().await;
                *guard = false;
            });
        }
    }
}

pub async fn stop_mcp_servers_with_context<R: Runtime>(
    app: &AppHandle<R>,
    state: &State<'_, AppState>,
    context: ShutdownContext,
) -> Result<(), String> {
    {
        let mut shutdown_in_progress = state.mcp_shutdown_in_progress.lock().await;
        if *shutdown_in_progress {
            return Ok(());
        }
        *shutdown_in_progress = true;
    }

    let _guard = ShutdownGuard {
        flag: state.mcp_shutdown_in_progress.clone(),
    };

    let active_startup_names: Vec<String> = {
        let active_servers = state.mcp_active_servers.lock().await;
        active_servers.keys().cloned().collect()
    };
    let mut start_generations = state.mcp_start_generations.lock().await;
    let pids = state.mcp_server_pids.lock().await;
    let pids_snapshot = pids.clone();
    let startup_names: HashSet<String> = active_startup_names
        .into_iter()
        .chain(pids_snapshot.keys().cloned())
        .collect();
    for name in startup_names {
        let generation = start_generations.entry(name).or_default();
        *generation = generation.wrapping_add(1);
    }
    drop(pids);
    drop(start_generations);
    let servers_to_stop: Vec<(String, RunningServiceEnum, Option<u16>)> = {
        let mut servers_map = state.mcp_servers.lock().await;
        let keys: Vec<String> = servers_map.keys().cloned().collect();

        let mut result = Vec::new();
        for key in keys {
            if let Some(service) = servers_map.remove(&key) {
                let port = if key == "Jan Browser MCP" {
                    let active_servers = state.mcp_active_servers.lock().await;
                    active_servers.get(&key).and_then(|config| {
                        config
                            .get("env")
                            .and_then(|e| e.get("BRIDGE_PORT"))
                            .and_then(|p| p.as_str())
                            .and_then(|s| s.parse::<u16>().ok())
                    })
                } else {
                    None
                };

                result.push((key, service, port));
            }
        }
        result
    };

    let server_names: Vec<String> = servers_to_stop
        .iter()
        .map(|(name, _, _)| name.clone())
        .collect();
    let per_server_timeout = context.per_server_timeout();
    let stop_handles: Vec<_> = servers_to_stop
        .into_iter()
        .map(|(name, service, port)| {
            let app_clone = app.clone();
            let process_pids = pids_snapshot
                .get(&name)
                .map(|server_pids| server_pids.values().copied().collect::<Vec<_>>())
                .unwrap_or_default();

            tauri::async_runtime::spawn(async move {
                let cancel_future = async {
                    match service {
                        RunningServiceEnum::NoInit(service) => service.cancel().await,
                        RunningServiceEnum::WithInit(service) => service.cancel().await,
                    }
                };

                let success = tokio::time::timeout(per_server_timeout, cancel_future)
                    .await
                    .map(|r| r.is_ok())
                    .unwrap_or(false);
                for pid in process_pids {
                    if let Err(error) = kill_process_tree_by_pid(pid).await {
                        log::warn!("Failed to clean up MCP server {name} process tree: {error}");
                    }
                }

                if name == "Jan Browser MCP" {
                    if let Some(port) = port {
                        use crate::core::mcp::lockfile::delete_lock_file;
                        if success {
                            tokio::time::sleep(Duration::from_millis(100)).await;
                        }
                        let _ = delete_lock_file(&app_clone, port);
                    }
                }

                (name, success)
            })
        })
        .collect();

    let overall_timeout = context.overall_timeout();
    let results = tokio::time::timeout(
        overall_timeout,
        futures_util::future::join_all(stop_handles),
    )
    .await;

    let _failed_servers: Vec<String> = match results {
        Ok(results) => {
            results
                .into_iter()
                .filter_map(|r| match r {
                    Ok((name, success)) if !success => Some(name),
                    Err(_) => None, // Task was cancelled/panicked
                    _ => None,
                })
                .collect()
        }
        Err(_) => {
            // Overall timeout - assume all servers need force-kill
            log::warn!("MCP shutdown timed out, will force-kill remaining processes");
            server_names.clone()
        }
    };

    // Ensure every tracked process tree is gone, including servers still handshaking.
    for (server_name, server_pids) in &pids_snapshot {
        for pid in server_pids.values().copied() {
            log::trace!("Ensuring MCP server {server_name} PID {pid} is stopped");
            if let Err(e) = kill_process_tree_by_pid(pid).await {
                log::error!("Failed to stop MCP process tree PID {}: {}", pid, e);
            }
        }
    }

    // Clean up PIDs from tracking
    {
        let mut pids = state.mcp_server_pids.lock().await;
        for (name, snapshot_pids) in &pids_snapshot {
            let remove_server_entry = if let Some(current_pids) = pids.get_mut(name) {
                for (generation, pid) in snapshot_pids {
                    if current_pids.get(generation) == Some(pid) {
                        current_pids.remove(generation);
                    }
                }
                current_pids.is_empty()
            } else {
                false
            };
            if remove_server_entry {
                pids.remove(name);
            }
        }
    }

    tokio::time::sleep(Duration::from_millis(200)).await;

    Ok(())
}

/// Store active server configuration for restart purposes
pub async fn store_active_server_config(
    active_servers_state: &Arc<Mutex<HashMap<String, Value>>>,
    name: &str,
    config: &Value,
) {
    let mut active_servers = active_servers_state.lock().await;
    active_servers.insert(name.to_string(), config.clone());
}

/// Materialise `mcp_config.json` from the default template when it is missing.
///
/// Startup migrations run before `setup_mcp` spawns, so any caller that reads
/// the config during setup must guarantee its existence itself.
pub fn ensure_mcp_config_exists<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
) -> Result<std::path::PathBuf, String> {
    let config_path = get_jan_data_folder_path(app_handle).join("mcp_config.json");
    if config_path.exists() {
        return Ok(config_path);
    }

    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create MCP config directory: {e}"))?;
    }

    log::info!("mcp_config.json not found, creating default config");
    std::fs::write(&config_path, default_mcp_config())
        .map_err(|e| format!("Failed to create default MCP config: {e}"))?;

    Ok(config_path)
}

// Add a new server configuration to the MCP config file
pub fn add_server_config<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    server_key: String,
    server_value: Value,
) -> Result<(), String> {
    add_server_config_with_path(app_handle, server_key, server_value, None)
}

// Add a new server configuration to the MCP config file with custom path support
pub fn add_server_config_with_path<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    server_key: String,
    server_value: Value,
    config_filename: Option<&str>,
) -> Result<(), String> {
    let config_filename = config_filename.unwrap_or("mcp_config.json");
    let config_path = get_jan_data_folder_path(app_handle).join(config_filename);

    let mut config: Value = serde_json::from_str(
        &std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read config file: {e}"))?,
    )
    .map_err(|e| format!("Failed to parse config: {e}"))?;

    config
        .as_object_mut()
        .ok_or("Config root is not an object")?
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(serde_json::Map::new()))
        .as_object_mut()
        .ok_or("mcpServers is not an object")?
        .insert(server_key, server_value);

    std::fs::write(
        &config_path,
        serde_json::to_string_pretty(&config)
            .map_err(|e| format!("Failed to serialize config: {e}"))?,
    )
    .map_err(|e| format!("Failed to write config file: {e}"))?;

    Ok(())
}
