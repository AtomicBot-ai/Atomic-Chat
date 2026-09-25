use tauri::{AppHandle, Manager, Runtime, State};
#[cfg(desktop)]
use tauri::Emitter;

#[cfg(desktop)]
use serde_json::Value;

#[cfg(desktop)]
use crate::core::atomic_core::client::CoreError;
#[cfg(desktop)]
use crate::core::atomic_core::commands::AtomicCoreClient;
#[cfg(desktop)]
use crate::core::server::ownership::{remember_config, ControlCaller, CoreOwner};
use crate::core::server::ownership::PublicApiOwner;
#[cfg(mobile)]
use crate::core::server::ownership::remember_config;
#[cfg(mobile)]
use crate::core::server::proxy::{self, ServerStart};
#[cfg(desktop)]
use crate::core::server::remote_provider_commands::{
    ProviderCustomHeader, RegisterProviderRequest,
};
use crate::core::server::request_inspector::ApiRequestLogSnapshot;
#[cfg(mobile)]
use crate::core::server::state_file;
use crate::core::state::{AppState, LocalServerEndpoint};

pub use crate::core::server::ownership::StartServerConfig;

/// The app's own proxy as the server owner — mobile only, where no core runs.
#[cfg(mobile)]
pub struct LegacyOwner<R: Runtime> {
    pub app: AppHandle<R>,
}

#[cfg(mobile)]
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

#[cfg(mobile)]
#[async_trait::async_trait]
impl<R: Runtime> PublicApiOwner for LegacyOwner<R> {

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

/// Control calls through the app's attachment — the normal path.
#[cfg(desktop)]
pub struct AttachedCaller<R: Runtime> {
    pub app: AppHandle<R>,
}

#[cfg(desktop)]
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
                "The Atomic Chat core is not running yet.",
                None,
            ));
        };
        client.call(method, path, body).await
    }
}

/// The core as the server owner, as seen from a command: the provider registrations the app holds
/// are handed over before it serves, so a core that restarted serves every cloud model.
#[cfg(desktop)]
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
    CoreOwner { caller, providers }
}

/// UI state follows confirmed listener state, never the requested port.
#[cfg(desktop)]
pub(crate) fn emit_server_state<R: Runtime>(app: &AppHandle<R>, owner: &str, port: Option<u16>, generation: Option<u64>) {
    if let Err(error) = app.emit("atomic-core://server-state-changed", serde_json::json!({
        "running": port.is_some(), "owner": owner, "port": port, "generation": generation,
    })) {
        log::debug!("[atomic-core] could not emit server state: {error}");
    }
}

#[cfg(mobile)]
fn remember_new_server(outcome: ServerStart, config: &StartServerConfig) -> u16 {
    match outcome {
        ServerStart::Started(port) => {
            remember_config(config);
            port
        }
        ServerStart::AlreadyRunning(port) => port,
    }
}

#[cfg(desktop)]
async fn publish_endpoint(state: &AppState, config: &StartServerConfig, port: u16) {
    *state.local_server_endpoint.lock().await = Some(LocalServerEndpoint::new(
        &config.host,
        port,
        &config.prefix,
        &config.api_key,
    ));
}

#[cfg(desktop)]
#[tauri::command]
pub async fn start_server<R: Runtime>(
    app_handle: AppHandle<R>,
    config: StartServerConfig,
) -> Result<u16, String> {
    let client = app_handle
        .try_state::<AtomicCoreClient>()
        .ok_or("The Atomic Chat core is not running yet.")?;
    let _gate = client.inner().owner_gate().await;
    let owner = core_owner(&app_handle, AttachedCaller { app: app_handle.clone() }).await;
    if let Some(port) = owner.running_port().await? {
        if crate::core::server::ownership::last_config().is_some() {
            client.set_server_running_intent(true);
        }
        emit_server_state(&app_handle, "core", Some(port), None);
        return Ok(port);
    }
    let port = owner.start(&config).await?;
    remember_config(&config);
    publish_endpoint(&app_handle.state::<AppState>(), &config, port).await;
    client.set_server_running_intent(true);
    emit_server_state(&app_handle, "core", Some(port), None);
    Ok(port)
}

#[cfg(mobile)]
#[tauri::command]
pub async fn start_server<R: Runtime>(
    app_handle: AppHandle<R>,
    config: StartServerConfig,
) -> Result<u16, String> {
    let owner = LegacyOwner { app: app_handle.clone() };
    if let Some(port) = owner.running_port().await? {
        return Ok(port);
    }
    Ok(remember_new_server(owner.start_outcome(&config).await?, &config))
}

#[cfg(desktop)]
#[tauri::command]
pub async fn stop_server<R: Runtime>(app_handle: AppHandle<R>) -> Result<(), String> {
    let client = app_handle
        .try_state::<AtomicCoreClient>()
        .ok_or("The Atomic Chat core is not running yet.")?;
    let _gate = client.inner().owner_gate().await;
    client.set_server_running_intent(false);
    CoreOwner { caller: AttachedCaller { app: app_handle.clone() }, providers: Vec::new() }
        .stop()
        .await?;
    app_handle.state::<AppState>().local_server_endpoint.lock().await.take();
    emit_server_state(&app_handle, "core", None, None);
    Ok(())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn stop_server<R: Runtime>(app_handle: AppHandle<R>) -> Result<(), String> {
    LegacyOwner { app: app_handle.clone() }.stop().await
}

#[cfg(desktop)]
#[tauri::command]
pub async fn get_server_status<R: Runtime>(app_handle: AppHandle<R>) -> Result<bool, String> {
    let client = app_handle
        .try_state::<AtomicCoreClient>()
        .ok_or("The Atomic Chat core is not running yet.")?;
    let _gate = client.inner().owner_gate().await;
    Ok(CoreOwner { caller: AttachedCaller { app: app_handle.clone() }, providers: Vec::new() }
        .running_port()
        .await?
        .is_some())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn get_server_status<R: Runtime>(app_handle: AppHandle<R>) -> Result<bool, String> {
    Ok(LegacyOwner { app: app_handle.clone() }.running_port().await?.is_some())
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
    #[cfg(desktop)]
    crate::core::atomic_core::api_requests::push_inspecting(&app_handle);
    #[cfg(mobile)]
    let _ = &app_handle;
    Ok(())
}

#[tauri::command]
pub async fn clear_api_request_log(state: State<'_, AppState>) -> Result<(), String> {
    state.api_request_inspector.clear();
    Ok(())
}

#[cfg(all(test, mobile))]
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
