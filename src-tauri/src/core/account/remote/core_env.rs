//! What the host needs from the core: where its public API can be reached
//! right now, and a way to make the core accept the keys it handed out.
//! Behind a trait so the host logic is tested without a core.

use async_trait::async_trait;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime};

use super::api::TunnelState;
use super::protocol::{is_dialable_url, Endpoint, EndpointKind};
use crate::core::atomic_core::commands::AtomicCoreClient;

/// The public API's reachability, as the core reports it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Reachability {
    pub server_running: bool,
    /// The server has its own API key; without one, device keys mean nothing.
    pub server_has_key: bool,
    /// `off`, `starting`, `online`, `stopping` or `error`, as the core says.
    pub tunnel: String,
    pub lan: bool,
    /// Never shown to the webview: they go only into sealed blobs.
    #[serde(skip)]
    pub endpoints: Vec<Endpoint>,
}

impl Reachability {
    /// What the backend's heartbeat takes.
    pub fn tunnel_state(&self) -> TunnelState {
        match self.tunnel.as_str() {
            "online" => TunnelState::Online,
            "error" => TunnelState::Error,
            _ => TunnelState::Off,
        }
    }
}

#[async_trait]
pub trait HostEnv: Send + Sync {
    async fn reachability(&self) -> Reachability;
    /// Replace the keys the public API accepts besides the server's own.
    async fn push_client_keys(&self, keys: Vec<String>) -> Result<(), String>;
}

fn normalize_prefix(prefix: &str) -> String {
    let trimmed = prefix.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        String::new()
    } else if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    }
}

/// Pure: the core's `GET /server`, `GET /remote-access` and `GET
/// /lan-addresses` answers turned into addresses a device can dial.
pub fn reachability_from(
    server: Option<&Value>,
    tunnel: Option<&Value>,
    lan: &[String],
) -> Reachability {
    let running = server
        .and_then(|s| s.get("running"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let host = server
        .and_then(|s| s.get("host"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let port = server
        .and_then(|s| s.get("port"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let prefix = normalize_prefix(
        server
            .and_then(|s| s.get("prefix"))
            .and_then(Value::as_str)
            .unwrap_or("/v1"),
    );
    let has_key = server
        .and_then(|s| s.get("requires_api_key"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let tunnel_state = tunnel
        .and_then(|t| t.get("state"))
        .and_then(Value::as_str)
        .unwrap_or("off")
        .to_string();
    let tunnel_url = tunnel
        .and_then(|t| t.get("url"))
        .and_then(Value::as_str)
        .filter(|_| tunnel_state == "online");
    let lan_on = running && host == "0.0.0.0" && port > 0;

    let mut endpoints = Vec::new();
    if running {
        if let Some(url) = tunnel_url {
            endpoints.push(Endpoint {
                kind: EndpointKind::Tunnel,
                url: format!("{}{prefix}", url.trim_end_matches('/')),
            });
        }
        if lan_on {
            for address in lan {
                endpoints.push(Endpoint {
                    kind: EndpointKind::Lan,
                    url: format!("http://{address}:{port}{prefix}"),
                });
            }
        }
    }
    endpoints.retain(|e| is_dialable_url(&e.url));

    Reachability {
        server_running: running,
        server_has_key: running && has_key,
        tunnel: if running {
            tunnel_state
        } else {
            "off".to_string()
        },
        lan: lan_on,
        endpoints,
    }
}

/// The real core, through the app's attachment to it.
pub struct CoreEnv<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> CoreEnv<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        Self { app }
    }

    async fn get(&self, path: &str) -> Option<Value> {
        let client = self.app.try_state::<AtomicCoreClient>()?;
        if !client.is_enabled() {
            return None;
        }
        match client.call("GET", path, None).await {
            Ok(value) => Some(value),
            Err(err) => {
                log::debug!("[remote] core {path} unavailable: {}", err.message);
                None
            }
        }
    }
}

#[async_trait]
impl<R: Runtime> HostEnv for CoreEnv<R> {
    async fn reachability(&self) -> Reachability {
        let server = self.get("/server").await;
        let tunnel = self.get("/remote-access").await;
        let lan = self
            .get("/lan-addresses")
            .await
            .and_then(|v| v.get("addresses").cloned())
            .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
            .unwrap_or_default();
        reachability_from(server.as_ref(), tunnel.as_ref(), &lan)
    }

    async fn push_client_keys(&self, keys: Vec<String>) -> Result<(), String> {
        let Some(client) = self.app.try_state::<AtomicCoreClient>() else {
            return Err("the core is not attached".to_string());
        };
        if !client.is_enabled() {
            return Err("the core is not attached".to_string());
        }
        client
            .call("PUT", "/server/client-keys", Some(json!({ "keys": keys })))
            .await
            .map(|_| ())
            .map_err(|e| format!("{}: {}", e.code, e.message))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_the_tunnel_then_each_lan_address_with_the_prefix() {
        let reach = reachability_from(
            Some(
                &json!({"running": true, "host": "0.0.0.0", "port": 1337, "prefix": "/v1", "requires_api_key": true}),
            ),
            Some(&json!({"state": "online", "url": "https://a-b.trycloudflare.com"})),
            &["192.168.1.5".to_string(), "10.0.0.9".to_string()],
        );
        assert!(reach.server_running && reach.server_has_key && reach.lan);
        assert_eq!(reach.tunnel_state(), TunnelState::Online);
        let urls: Vec<_> = reach.endpoints.iter().map(|e| e.url.as_str()).collect();
        assert_eq!(
            urls,
            [
                "https://a-b.trycloudflare.com/v1",
                "http://192.168.1.5:1337/v1",
                "http://10.0.0.9:1337/v1"
            ]
        );
    }

    #[test]
    fn a_loopback_server_without_a_tunnel_has_no_address() {
        let reach = reachability_from(
            Some(
                &json!({"running": true, "host": "127.0.0.1", "port": 1337, "prefix": "v1/", "requires_api_key": false}),
            ),
            Some(&json!({"state": "starting", "url": null})),
            &["192.168.1.5".to_string()],
        );
        assert!(!reach.lan && !reach.server_has_key);
        assert_eq!(reach.tunnel, "starting");
        assert_eq!(reach.tunnel_state(), TunnelState::Off);
        assert!(reach.endpoints.is_empty());
    }

    #[test]
    fn a_stopped_server_reaches_nothing() {
        let reach = reachability_from(
            Some(&json!({"running": false, "host": "0.0.0.0", "port": 1337, "prefix": "/v1"})),
            Some(&json!({"state": "online", "url": "https://x.trycloudflare.com"})),
            &["192.168.1.5".to_string()],
        );
        assert_eq!(reach.tunnel, "off");
        assert!(reach.endpoints.is_empty());
        assert_eq!(
            reachability_from(None, None, &[]),
            Reachability {
                tunnel: "off".into(),
                ..Default::default()
            }
        );
    }

    #[test]
    fn the_webview_never_sees_the_addresses() {
        let reach = reachability_from(
            Some(&json!({"running": true, "host": "0.0.0.0", "port": 1337, "prefix": "/v1"})),
            Some(&json!({"state": "online", "url": "https://secret-words.trycloudflare.com"})),
            &[],
        );
        let shown = serde_json::to_string(&reach).unwrap();
        assert!(!shown.contains("secret-words"));
    }
}
