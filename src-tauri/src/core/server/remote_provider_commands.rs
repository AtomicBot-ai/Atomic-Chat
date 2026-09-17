use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};

use crate::core::state::{AppState, ProviderConfig};

/// Custom header for provider requests
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderCustomHeader {
    pub header: String,
    pub value: String,
}

/// Request to register/update a remote provider config
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterProviderRequest {
    pub provider: String,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub custom_headers: Vec<ProviderCustomHeader>,
    pub models: Vec<String>,
}

/// Register a remote provider configuration
#[tauri::command]
pub async fn register_provider_config<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    request: RegisterProviderRequest,
) -> Result<(), String> {
    // On desktop the core serves the public API, so its registry is the one that routes; the app
    // keeps its own copy to hand the core again after a restart. Mobile has no core: the app's
    // proxy routes from this copy alone.
    #[cfg(desktop)]
    let owner = app.try_state::<crate::core::atomic_core::commands::AtomicCoreClient>();
    // Recovery reads provider_configs under this gate. Keep it until the local copy has caught up
    // with the core write, otherwise a new generation can recover from the old copy.
    #[cfg(desktop)]
    let _gate = match owner.as_ref() {
        Some(owner) => Some(owner.owner_gate().await),
        None => None,
    };
    #[cfg(desktop)]
    crate::core::atomic_core::cloud::mirror_provider(&app, &request).await?;
    #[cfg(mobile)]
    let _ = &app;

    let provider_configs = state.provider_configs.clone();
    let mut configs = provider_configs.lock().await;

    let config = ProviderConfig {
        provider: request.provider.clone(),
        api_key: request.api_key,
        base_url: request.base_url,
        custom_headers: request
            .custom_headers
            .into_iter()
            .map(|h| crate::core::state::ProviderCustomHeader {
                header: h.header,
                value: h.value,
            })
            .collect(),
        models: request.models, // Models will be added when they are configured
    };

    let provider_name = request.provider.clone();
    configs.insert(provider_name.clone(), config);
    log::info!("Registered provider config: {provider_name}");
    Ok(())
}

/// Unregister a provider configuration
#[tauri::command]
pub async fn unregister_provider_config<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    provider: String,
) -> Result<(), String> {
    #[cfg(desktop)]
    let owner = app.try_state::<crate::core::atomic_core::commands::AtomicCoreClient>();
    #[cfg(desktop)]
    let _gate = match owner.as_ref() {
        Some(owner) => Some(owner.owner_gate().await),
        None => None,
    };
    #[cfg(desktop)]
    crate::core::atomic_core::cloud::unmirror_provider(&app, &provider).await?;
    #[cfg(mobile)]
    let _ = &app;

    let provider_configs = state.provider_configs.clone();
    let mut configs = provider_configs.lock().await;

    if configs.remove(&provider).is_some() {
        log::info!("Unregistered provider config: {provider}");
        Ok(())
    } else {
        Ok(())
    }
}
