//! Proves a freshly minted tunnel URL reaches *this* server before it is shown
//! to the user.
//!
//! "Registered" only means cloudflared has an edge connection. The public name
//! still has to propagate, and until it does a visitor gets Cloudflare's own
//! error page. A QR code that opens an error page is worse than a few more
//! seconds of "Starting…", so the URL is fetched once from the outside first.
//!
//! The probe goes through Cloudflare's edge *by SNI* before it ever asks DNS
//! for the new name: the edge routes on the TLS server name, so it serves the
//! tunnel before the hostname resolves anywhere, and an early OS lookup would
//! negative-cache the NXDOMAIN (for up to half an hour on some resolvers) and
//! blind every later attempt. Only when the edge path gives nothing does the
//! probe fall back to the hostname, inside the same overall budget.

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use futures_util::StreamExt;

/// Served without an API key and exempt from Host validation (it is the Swagger
/// document), so it answers the same whatever the user configured.
const PROBE_PATH: &str = "/openapi.json";
/// `info.title` of `static/openapi.json`. A Cloudflare error page, a captive
/// portal or somebody else's server is an *answer*, but not this one.
const PROBE_MARKER: &str = "Atomic Chat API Server Endpoints";
/// The real document is ~33 KB; anything far larger is not ours.
const PROBE_BODY_CAP: usize = 256 * 1024;

const EDGE_HOST: &str = "trycloudflare.com";
/// Leaves most of the budget to the hostname fallback.
const EDGE_WAIT_MAX: Duration = Duration::from_secs(15);
const EDGE_RETRY_DELAY: Duration = Duration::from_millis(500);
/// A network that blocks the edge blocks every attempt; stop paying for it.
const EDGE_MAX_UNREACHABLE_ROUNDS: u32 = 2;
const HOSTNAME_RETRY_DELAY: Duration = Duration::from_secs(1);
const ATTEMPT_TIMEOUT: Duration = Duration::from_secs(5);

#[async_trait]
pub(crate) trait Prober: Send + Sync {
    /// `true` once `url` answers as this app's Local API Server, `false` if it
    /// never does within `budget`.
    async fn verify(&self, url: &str, budget: Duration) -> bool;
}

/// What one fetch established.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProbeAnswer {
    /// Our document came back.
    Ours,
    /// Something answered, but not this server (yet).
    Foreign,
    /// Nothing answered at all.
    Unreachable,
}

pub(crate) fn body_is_ours(body: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|json| {
            json.pointer("/info/title")
                .and_then(serde_json::Value::as_str)
                .map(|title| title == PROBE_MARKER)
        })
        .unwrap_or(false)
}

pub(crate) async fn probe_once(client: &reqwest::Client, base_url: &str) -> ProbeAnswer {
    let url = format!("{}{PROBE_PATH}", base_url.trim_end_matches('/'));
    let response = match client.get(&url).send().await {
        Ok(response) => response,
        Err(error) => {
            log::debug!("[remote-access] probe of {url} got no answer: {error}");
            return ProbeAnswer::Unreachable;
        }
    };
    if !response.status().is_success() {
        log::debug!(
            "[remote-access] probe of {url} answered {}",
            response.status()
        );
        return ProbeAnswer::Foreign;
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else {
            return ProbeAnswer::Foreign;
        };
        if body.len() + chunk.len() > PROBE_BODY_CAP {
            return ProbeAnswer::Foreign;
        }
        body.extend_from_slice(&chunk);
    }
    if body_is_ours(&body) {
        ProbeAnswer::Ours
    } else {
        ProbeAnswer::Foreign
    }
}

fn host_of(url: &str) -> Option<String> {
    url::Url::parse(url)
        .ok()?
        .host_str()
        .map(|host| host.to_string())
}

fn client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .timeout(ATTEMPT_TIMEOUT)
        // Every attempt must be a fresh connection: a pooled one would keep
        // answering from wherever the previous attempt landed.
        .pool_max_idle_per_host(0)
        .user_agent("atomic-chat-remote-access-probe")
}

/// Cloudflare's edge addresses, IPv4 first, at most two distinct ones.
async fn edge_addresses() -> Vec<SocketAddr> {
    let Ok(resolved) = tokio::net::lookup_host((EDGE_HOST, 443)).await else {
        return Vec::new();
    };
    let mut addresses: Vec<SocketAddr> = Vec::new();
    for address in resolved {
        if !addresses.contains(&address) {
            addresses.push(address);
        }
    }
    addresses.sort_by_key(|address| !address.is_ipv4());
    addresses.truncate(2);
    addresses
}

/// The production prober: edge-by-SNI first, then the hostname.
pub(crate) struct PublicProber;

impl PublicProber {
    async fn verify_through_edge(&self, url: &str, host: &str, deadline: Instant) -> bool {
        let edge_deadline = deadline.min(Instant::now() + EDGE_WAIT_MAX);
        let addresses = edge_addresses().await;
        if addresses.is_empty() {
            return false;
        }
        let mut unreachable_rounds = 0;
        while Instant::now() < edge_deadline {
            let mut any_answer = false;
            for address in &addresses {
                // `resolve` pins the connection to the edge address while the
                // TLS server name and `Host` stay the tunnel's: the SNI route.
                let Ok(client) = client_builder().resolve(host, *address).build() else {
                    continue;
                };
                match probe_once(&client, url).await {
                    ProbeAnswer::Ours => return true,
                    ProbeAnswer::Foreign => any_answer = true,
                    ProbeAnswer::Unreachable => {}
                }
            }
            if any_answer {
                unreachable_rounds = 0;
            } else {
                unreachable_rounds += 1;
                if unreachable_rounds >= EDGE_MAX_UNREACHABLE_ROUNDS {
                    return false;
                }
            }
            tokio::time::sleep(EDGE_RETRY_DELAY).await;
        }
        false
    }

    async fn verify_through_hostname(&self, url: &str, deadline: Instant) -> bool {
        let Ok(client) = client_builder().build() else {
            return false;
        };
        while Instant::now() < deadline {
            if probe_once(&client, url).await == ProbeAnswer::Ours {
                return true;
            }
            tokio::time::sleep(HOSTNAME_RETRY_DELAY).await;
        }
        false
    }
}

#[async_trait]
impl Prober for PublicProber {
    async fn verify(&self, url: &str, budget: Duration) -> bool {
        let Some(host) = host_of(url) else {
            return false;
        };
        let deadline = Instant::now() + budget;
        if self.verify_through_edge(url, &host, deadline).await {
            return true;
        }
        self.verify_through_hostname(url, deadline).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyper::service::{make_service_fn, service_fn};
    use hyper::{Body, Request, Response, Server};
    use std::convert::Infallible;

    /// Serves `body` with `status` on every path; returns the base URL.
    async fn stub_server(status: u16, body: &'static str) -> String {
        let make_service = make_service_fn(move |_| async move {
            Ok::<_, Infallible>(service_fn(move |_request: Request<Body>| async move {
                Ok::<_, Infallible>(
                    Response::builder()
                        .status(status)
                        .body(Body::from(body))
                        .unwrap(),
                )
            }))
        });
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        tokio::spawn(async move {
            let _ = Server::from_tcp(listener)
                .unwrap()
                .serve(make_service)
                .await;
        });
        format!("http://127.0.0.1:{port}")
    }

    fn client() -> reqwest::Client {
        client_builder().no_proxy().build().unwrap()
    }

    /// The marker is a copy of a string that lives in another file; if the
    /// document's title is ever reworded the probe must be reworded with it.
    #[test]
    fn the_marker_matches_the_document_the_proxy_really_serves() {
        let document = include_str!("../../../../static/openapi.json");
        assert!(body_is_ours(document.as_bytes()));
        assert!(document.len() < PROBE_BODY_CAP);
    }

    #[test]
    fn other_bodies_are_not_ours() {
        assert!(!body_is_ours(b"<html>Cloudflare Tunnel error 1033</html>"));
        assert!(!body_is_ours(br#"{"info":{"title":"Some Other API"}}"#));
        assert!(!body_is_ours(br#"{"service":"Unsloth UI Backend"}"#));
        assert!(!body_is_ours(b""));
    }

    #[test]
    fn the_host_is_taken_from_the_tunnel_url() {
        assert_eq!(
            host_of("https://calm-river-demo.trycloudflare.com").as_deref(),
            Some("calm-river-demo.trycloudflare.com")
        );
        assert_eq!(host_of("not a url"), None);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn our_document_is_recognised() {
        let base = stub_server(
            200,
            r#"{"openapi":"3.0.0","info":{"title":"Atomic Chat API Server Endpoints"}}"#,
        )
        .await;
        assert_eq!(probe_once(&client(), &base).await, ProbeAnswer::Ours);
        // A trailing slash on the base must not produce `//openapi.json`.
        assert_eq!(
            probe_once(&client(), &format!("{base}/")).await,
            ProbeAnswer::Ours
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_cloudflare_error_page_is_an_answer_but_not_ours() {
        let base = stub_server(530, "<html>error code: 1033</html>").await;
        assert_eq!(probe_once(&client(), &base).await, ProbeAnswer::Foreign);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_foreign_server_that_says_200_is_still_not_ours() {
        let base = stub_server(200, r#"{"info":{"title":"Captive Portal"}}"#).await;
        assert_eq!(probe_once(&client(), &base).await, ProbeAnswer::Foreign);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_closed_port_is_unreachable() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert_eq!(
            probe_once(&client(), &format!("http://127.0.0.1:{port}")).await,
            ProbeAnswer::Unreachable
        );
    }
}
