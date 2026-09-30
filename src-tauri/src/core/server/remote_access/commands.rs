//! IPC surface of the "Remote & LAN" settings page. Desktop only: registered
//! in the desktop `generate_handler!` block and listed as such in the
//! frontend's `ipc-contract` test.

use tauri::{AppHandle, Runtime, State};

use super::{lan, RemoteAccessStatus};
use crate::core::state::AppState;

#[tauri::command]
pub async fn get_remote_access_status<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<RemoteAccessStatus, String> {
    // `AppState` is built before an `AppHandle` exists, so every entry point
    // binds the emitter. Idempotent.
    state.remote_access.attach(app);
    Ok(state
        .remote_access
        .status(&state.local_server_endpoint)
        .await)
}

/// Resolves at once with `starting`; the URL arrives as a
/// `remote-access:status` event. Rejects with `server_stopped` when there is
/// no Local API Server to point the tunnel at.
#[tauri::command]
pub async fn start_remote_access<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<RemoteAccessStatus, String> {
    state.remote_access.attach(app);
    state
        .remote_access
        .start(
            state.local_server_endpoint.clone(),
            state.dynamic_trusted_hosts.clone(),
        )
        .await
}

/// Resolves once the tunnel process is gone.
#[tauri::command]
pub async fn stop_remote_access<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
) -> Result<RemoteAccessStatus, String> {
    state.remote_access.attach(app);
    Ok(state
        .remote_access
        .stop(&state.local_server_endpoint, &state.dynamic_trusted_hosts)
        .await)
}

/// IPv4 addresses another device on the network can dial, the default-route
/// one first. For display: Host validation does not depend on this list.
#[tauri::command]
pub async fn get_lan_addresses() -> Result<Vec<String>, String> {
    // Interface enumeration is a blocking OS call.
    tokio::task::spawn_blocking(lan::lan_addresses)
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::*;
    use crate::test_support::IpcTestHarness;

    fn harness() -> IpcTestHarness {
        IpcTestHarness::new(|builder| {
            builder
                .manage(AppState::default())
                .invoke_handler(tauri::generate_handler![
                    get_remote_access_status,
                    start_remote_access,
                    stop_remote_access,
                    get_lan_addresses,
                ])
        })
    }

    /// The frontend reads these exact keys; a serde default (snake_case) would
    /// blank the card without any error.
    #[test]
    fn the_status_crosses_ipc_in_camel_case() {
        let harness = harness();
        let status: Value = harness
            .invoke("get_remote_access_status", json!({}))
            .unwrap();
        assert_eq!(
            status,
            json!({
                "state": "off",
                "url": null,
                "error": null,
                "blockReason": "server_stopped",
                "canStart": false,
                "canStop": false,
                "serverHasApiKey": false,
            })
        );
    }

    #[test]
    fn starting_without_a_server_is_refused_with_the_block_reason() {
        let harness = harness();
        let refusal = harness
            .invoke::<Value>("start_remote_access", json!({}))
            .unwrap_err();
        assert_eq!(refusal, json!("server_stopped"));
        // Nothing was started, so stopping is a calm no-op.
        let status: Value = harness.invoke("stop_remote_access", json!({})).unwrap();
        assert_eq!(status["state"], "off");
    }

    #[test]
    fn lan_addresses_cross_ipc_as_a_list_of_ipv4_literals() {
        let harness = harness();
        let addresses: Vec<String> = harness.invoke("get_lan_addresses", json!({})).unwrap();
        for address in addresses {
            address
                .parse::<std::net::Ipv4Addr>()
                .expect("an IPv4 literal");
        }
    }
}
