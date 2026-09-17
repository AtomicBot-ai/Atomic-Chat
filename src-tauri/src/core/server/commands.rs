use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::core::atomic_core::client::CoreError;
use crate::core::atomic_core::cloud::core_owns_server;
use crate::core::atomic_core::commands::AtomicCoreClient;
use crate::core::server::ownership::{last_config, remember_config, ControlCaller, CoreOwner, PublicApiOwner};
use crate::core::server::proxy::{self, ServerStart};
use crate::core::server::remote_provider_commands::{
    ProviderCustomHeader, RegisterProviderRequest,
};
use crate::core::server::request_inspector::ApiRequestLogSnapshot;
use crate::core::server::state_file;
use crate::core::state::{AppState, LocalServerEndpoint};

pub use crate::core::server::ownership::StartServerConfig;

/// The app's own proxy as the server owner.
pub struct LegacyOwner<R: Runtime> {
    pub app: AppHandle<R>,
}

impl<R: Runtime> LegacyOwner<R> {
    async fn start_outcome(&self, config: &StartServerConfig) -> Result<ServerStart, String> {
        let state = self.app.state::<AppState>();
        let StartServerConfig {
            host,
            port,
            prefix,
            api_key,
            trusted_hosts,
            proxy_timeout,
        } = config.clone();
        // The CLI is headless and cannot read these settings out of the webview's
        // localStorage, so mirror the effective address to disk for `server status`.
        let requires_api_key = !api_key.is_empty();
        let server_handle = state.server_handle.clone();
        // One resolver for every session the proxy can route to, whoever owns it.
        let resolver = crate::core::sessions::resolver_for(&self.app, &state);

        // `AppState` is built before `.setup()`, so this is the first point where
        // the inspector and an `AppHandle` exist together. Idempotent.
        state.api_request_inspector.attach(self.app.clone());

        let started = proxy::start_server(
            self.app.clone(),
            server_handle,
            resolver,
            host.clone(),
            port,
            prefix.clone(),
            api_key.clone(),
            vec![trusted_hosts],
            proxy_timeout,
            state.provider_configs.clone(),
            state.auto_increase_ctx.clone(),
            state.api_request_inspector.clone(),
        )
        .await
        .map_err(|e| e.to_string())?;
        let actual_port = match started {
            // The endpoint and the status file already describe the server that is
            // up; this caller's config did not take effect, so leave them be.
            ServerStart::AlreadyRunning(port) => return Ok(ServerStart::AlreadyRunning(port)),
            ServerStart::Started(port) => port,
        };
        // Publish the effective endpoint so in-process callers (the agent's cloud
        // path) can reach the proxy. `actual_port` matters: a requested port of 0
        // is auto-assigned.
        *state.local_server_endpoint.lock().await = Some(LocalServerEndpoint::new(
            &host,
            actual_port,
            &prefix,
            &api_key,
        ));

        state_file::mark_running(&host, actual_port, &prefix, requires_api_key);
        Ok(ServerStart::Started(actual_port))
    }
}

#[async_trait::async_trait]
impl<R: Runtime> PublicApiOwner for LegacyOwner<R> {
    fn label(&self) -> &'static str {
        "app"
    }

    async fn running_port(&self) -> Result<Option<u16>, String> {
        let state = self.app.state::<AppState>();
        let port = state
            .server_handle
            .lock()
            .await
            .as_ref()
            .map(|handle| handle.port);
        Ok(port)
    }

    async fn start(&self, config: &StartServerConfig) -> Result<u16, String> {
        Ok(self.start_outcome(config).await?.port())
    }

    async fn stop(&self) -> Result<(), String> {
        let state = self.app.state::<AppState>();
        proxy::stop_server(state.server_handle.clone())
            .await
            .map_err(|e| e.to_string())?;
        state.local_server_endpoint.lock().await.take();
        state_file::mark_stopped();
        Ok(())
    }
}

/// Control calls through the app's attachment, with its gates — the normal path.
pub struct AttachedCaller<R: Runtime> {
    pub app: AppHandle<R>,
}

#[async_trait::async_trait]
impl<R: Runtime> ControlCaller for AttachedCaller<R> {
    async fn call(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, CoreError> {
        let Some(client) = self.app.try_state::<AtomicCoreClient>() else {
            return Err(CoreError::new(
                "CORE_NOT_RUNNING",
                "The Atomic Chat core integration is not available in this build.",
                None,
            ));
        };
        client.call(method, path, body).await
    }
}

/// The core as the server owner, as seen from a command: the provider registrations
/// currently known are handed over before it serves, and the endpoint is kept
/// current for in-process callers.
pub async fn core_owner<R: Runtime, C: ControlCaller>(
    app: &AppHandle<R>,
    caller: C,
) -> CoreOwner<C> {
    let state = app.state::<AppState>();
    let providers = state
        .provider_configs
        .lock()
        .await
        .values()
        .map(|config| {
            (
                config.provider.clone(),
                crate::core::atomic_core::cloud::provider_body(&RegisterProviderRequest {
                    provider: config.provider.clone(),
                    api_key: config.api_key.clone(),
                    base_url: config.base_url.clone(),
                    custom_headers: config
                        .custom_headers
                        .iter()
                        .map(|h| ProviderCustomHeader {
                            header: h.header.clone(),
                            value: h.value.clone(),
                        })
                        .collect(),
                    models: config.models.clone(),
                }),
            )
        })
        .collect();
    CoreOwner {
        caller,
        providers,
        external_sessions: crate::core::atomic_core::external::legacy_sessions(app).await,
        external_generation: crate::core::atomic_core::external::generation(),
    }
}

async fn publish_core_endpoint<R: Runtime>(
    app: &AppHandle<R>,
    config: &StartServerConfig,
    port: u16,
) {
    let state = app.state::<AppState>();
    *state.local_server_endpoint.lock().await = Some(LocalServerEndpoint::new(
        &config.host,
        port,
        &config.prefix,
        &config.api_key,
    ));
}

/// UI state follows confirmed listener state, never the requested port or a guessed owner.
pub(crate) fn emit_server_state<R: Runtime>(app: &AppHandle<R>, owner: &str, port: Option<u16>, generation: Option<u64>) {
    if let Err(error) = app.emit("atomic-core://server-state-changed", serde_json::json!({
        "running": port.is_some(), "owner": owner, "port": port, "generation": generation,
    })) {
        log::debug!("[atomic-core] could not emit server state: {error}");
    }
}

fn remember_new_server(outcome: ServerStart, config: &StartServerConfig) -> u16 {
    match outcome {
        ServerStart::Started(port) => {
            remember_config(config);
            port
        }
        ServerStart::AlreadyRunning(port) => port,
    }
}

#[tauri::command]
pub async fn start_server<R: Runtime>(
    app_handle: AppHandle<R>,
    config: StartServerConfig,
) -> Result<u16, String> {
    let client = app_handle.try_state::<AtomicCoreClient>();
    let _gate = if let Some(client) = client.as_ref() {
        Some(client.owner_gate().await)
    } else {
        None
    };
    if let Some(client) = client.as_ref() { client.ensure_reconciled()?; }
    if core_owns_server(&app_handle) {
        let owner = core_owner(
            &app_handle,
            AttachedCaller {
                app: app_handle.clone(),
            },
        )
        .await;
        if let Some(port) = owner.running_port().await? {
            if last_config().is_some() {
                if let Some(client) = client.as_ref() { client.set_server_running_intent(true); }
            }
            emit_server_state(&app_handle, "core", Some(port), None);
            return Ok(port);
        }
        let port = owner.start(&config).await?;
        remember_config(&config);
        publish_core_endpoint(&app_handle, &config, port).await;
        if let Some(client) = client.as_ref() { client.set_server_running_intent(true); }
        emit_server_state(&app_handle, "core", Some(port), None);
        return Ok(port);
    }
    let owner = LegacyOwner {
        app: app_handle.clone(),
    };
    if let Some(port) = owner.running_port().await? {
        if last_config().is_some() {
            if let Some(client) = client.as_ref() { client.set_server_running_intent(true); }
        }
        emit_server_state(&app_handle, "legacy", Some(port), None);
        return Ok(port);
    }
    let port = remember_new_server(
        owner.start_outcome(&config).await?,
        &config,
    );
    if let Some(client) = client.as_ref() { client.set_server_running_intent(true); }
    emit_server_state(&app_handle, "legacy", Some(port), None);
    Ok(port)
}

#[tauri::command]
pub async fn stop_server<R: Runtime>(app_handle: AppHandle<R>) -> Result<(), String> {
    let client = app_handle.try_state::<AtomicCoreClient>();
    let _gate = if let Some(client) = client.as_ref() {
        Some(client.owner_gate().await)
    } else {
        None
    };
    if let Some(client) = client.as_ref() { client.ensure_reconciled()?; }
    if let Some(client) = client.as_ref() { client.set_server_running_intent(false); }
    if core_owns_server(&app_handle) {
        CoreOwner {
            caller: AttachedCaller {
                app: app_handle.clone(),
            },
            providers: Vec::new(),
            external_sessions: Vec::new(),
            external_generation: crate::core::atomic_core::external::generation(),
        }
        .stop()
        .await?;
        app_handle
            .state::<AppState>()
            .local_server_endpoint
            .lock()
            .await
            .take();
        emit_server_state(&app_handle, "core", None, None);
        return Ok(());
    }
    LegacyOwner {
        app: app_handle.clone(),
    }
    .stop()
    .await?;
    emit_server_state(&app_handle, "legacy", None, None);
    Ok(())
}

#[tauri::command]
pub async fn get_server_status<R: Runtime>(app_handle: AppHandle<R>) -> Result<bool, String> {
    let client = app_handle.try_state::<AtomicCoreClient>();
    let _gate = if let Some(client) = client.as_ref() {
        Some(client.owner_gate().await)
    } else {
        None
    };
    if let Some(client) = client.as_ref() { client.ensure_reconciled()?; }
    if core_owns_server(&app_handle) {
        return Ok(CoreOwner {
            caller: AttachedCaller {
                app: app_handle.clone(),
            },
            providers: Vec::new(),
            external_sessions: Vec::new(),
            external_generation: crate::core::atomic_core::external::generation(),
        }
        .running_port()
        .await?
        .is_some());
    }
    Ok(LegacyOwner {
        app: app_handle.clone(),
    }
    .running_port()
    .await?
    .is_some())
}

/// Snapshot of the live request log, used to hydrate the API screen on mount.
#[tauri::command]
pub async fn get_api_request_log(
    state: State<'_, AppState>,
) -> Result<ApiRequestLogSnapshot, String> {
    Ok(state.api_request_inspector.snapshot())
}

/// Refcounted: recording only happens while at least one view is watching, and
/// the ring is wiped when the last one leaves so prompt previews do not
/// outlive the screen showing them.
#[tauri::command]
pub async fn set_api_inspector_enabled<R: Runtime>(
    app_handle: AppHandle<R>,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    state.api_request_inspector.set_enabled(enabled);
    // A core serving the Local API collects previews only while this screen watches.
    crate::core::atomic_core::api_requests::push_inspecting(&app_handle);
    Ok(())
}

#[tauri::command]
pub async fn clear_api_request_log(state: State<'_, AppState>) -> Result<(), String> {
    state.api_request_inspector.clear();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn already_running_never_overwrites_the_last_successful_configuration() {
        let old = StartServerConfig {
            host: "127.0.0.1".into(),
            port: 1337,
            prefix: "/v1".into(),
            api_key: "old".into(),
            trusted_hosts: Vec::new(),
            proxy_timeout: 600,
        };
        let mut attempted = old.clone();
        attempted.api_key = "new".into();
        assert_eq!(remember_new_server(ServerStart::Started(1337), &old), 1337);
        assert_eq!(
            remember_new_server(ServerStart::AlreadyRunning(1337), &attempted),
            1337
        );
        assert_eq!(crate::core::server::ownership::last_config(), Some(old));
    }
}
