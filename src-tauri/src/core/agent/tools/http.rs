use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, LOCATION};
use reqwest::{Method, Response, Url};
use serde_json::Value;

use super::{required_string, truncate, ToolContext, MAX_TOOL_OUTPUT_CHARS};
use crate::core::agent::types::ToolOutcome;

const MAX_REDIRECTS: usize = 5;

pub async fn execute(args: &Value, _context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let url = required_string(args, "url").map_err(ToolOutcome::error)?;
    let method = args
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("GET")
        .parse::<Method>()
        .map_err(|error| ToolOutcome::error(format!("Invalid HTTP method: {error}")))?;
    let timeout_ms = args
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(30_000)
        .clamp(1_000, 120_000);
    let mut headers = HeaderMap::new();
    if let Some(values) = args.get("headers").and_then(Value::as_object) {
        for (name, value) in values {
            let name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|error| ToolOutcome::error(format!("Invalid header name: {error}")))?;
            let value = HeaderValue::from_str(
                value
                    .as_str()
                    .ok_or_else(|| ToolOutcome::error("HTTP header values must be strings"))?,
            )
            .map_err(|error| ToolOutcome::error(format!("Invalid header value: {error}")))?;
            headers.insert(name, value);
        }
    }
    let response = request_guarded(
        method,
        &url,
        headers,
        args.get("body").and_then(Value::as_str).map(str::to_owned),
        Duration::from_millis(timeout_ms),
    )
    .await?;
    let status = response.status();
    let response_headers = response
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.to_string(),
                Value::String(value.to_str().unwrap_or("<binary>").to_owned()),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    let body = response
        .text()
        .await
        .map_err(|error| ToolOutcome::error(error.to_string()))?;
    let summary = truncate(body, MAX_TOOL_OUTPUT_CHARS);
    let outcome = ToolOutcome {
        status: if status.is_success() {
            crate::core::agent::types::ToolStatus::Ok
        } else {
            crate::core::agent::types::ToolStatus::Error
        },
        summary,
        details: Some(serde_json::json!({
            "status": status.as_u16(),
            "headers": response_headers,
        })),
    };
    if status.is_success() {
        Ok(outcome)
    } else {
        Err(outcome)
    }
}

pub(super) async fn request_guarded(
    method: Method,
    initial_url: &str,
    headers: HeaderMap,
    body: Option<String>,
    timeout: Duration,
) -> Result<Response, ToolOutcome> {
    let mut url = Url::parse(initial_url)
        .map_err(|error| ToolOutcome::error(format!("Invalid URL: {error}")))?;
    for redirect_count in 0..=MAX_REDIRECTS {
        let (validated_url, addresses) = validate_public_http_url(url).await?;
        url = validated_url;
        let host = url
            .host_str()
            .ok_or_else(|| ToolOutcome::error("URL has no host"))?
            .to_owned();
        let mut builder = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none());
        for address in addresses {
            builder = builder.resolve(&host, address);
        }
        let client = builder
            .build()
            .map_err(|error| ToolOutcome::error(format!("Could not build HTTP client: {error}")))?;
        let response = client
            .request(method.clone(), url.clone())
            .headers(headers.clone())
            .body(body.clone().unwrap_or_default())
            .timeout(timeout)
            .send()
            .await
            .map_err(|error| ToolOutcome::error(format!("HTTP request failed: {error}")))?;
        if !response.status().is_redirection() {
            return Ok(response);
        }
        if redirect_count == MAX_REDIRECTS {
            return Err(ToolOutcome::error("Too many HTTP redirects"));
        }
        let location = response
            .headers()
            .get(LOCATION)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| ToolOutcome::error("Redirect response has no valid Location header"))?;
        let redirected = url
            .join(location)
            .map_err(|error| ToolOutcome::error(format!("Invalid redirect URL: {error}")))?;
        url = redirected;
    }
    Err(ToolOutcome::error("HTTP redirect resolution failed"))
}

async fn validate_public_http_url(
    url: Url,
) -> Result<(Url, Vec<std::net::SocketAddr>), ToolOutcome> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(ToolOutcome::error("Only http and https URLs are allowed"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ToolOutcome::error("Credentials in URLs are not allowed"));
    }
    let host = url
        .host_str()
        .ok_or_else(|| ToolOutcome::error("URL has no host"))?;
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".local") {
        return Err(ToolOutcome::error("Local network hosts are blocked"));
    }
    let port = url
        .port_or_known_default()
        .ok_or_else(|| ToolOutcome::error("URL has no resolvable port"))?;
    let addresses = tokio::net::lookup_host((host, port))
        .await
        .map_err(|error| ToolOutcome::error(format!("Could not resolve host: {error}")))?;
    let mut found = false;
    let mut allowed = Vec::new();
    for address in addresses {
        found = true;
        if is_blocked_ip(address.ip()) {
            return Err(ToolOutcome::error(format!(
                "Host resolves to blocked address {}",
                address.ip()
            )));
        }
        allowed.push(address);
    }
    if !found {
        return Err(ToolOutcome::error("Host resolved to no addresses"));
    }
    Ok((url, allowed))
}

fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_blocked_ipv4(ip),
        IpAddr::V6(ip) => is_blocked_ipv6(ip),
    }
}

fn is_blocked_ipv4(ip: Ipv4Addr) -> bool {
    ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.octets()[0] == 0
        || ip.octets()[0] >= 240
        || matches!(ip.octets(), [100, 64..=127, _, _])
        || matches!(ip.octets(), [198, 18..=19, _, _])
}

fn is_blocked_ipv6(ip: Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return is_blocked_ipv4(mapped);
    }
    ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || (ip.segments()[0] & 0xfe00) == 0xfc00
        || (ip.segments()[0] & 0xffc0) == 0xfe80
        || (ip.segments()[0] == 0x2001 && ip.segments()[1] == 0x0db8)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_private_and_special_addresses() {
        for value in [
            "127.0.0.1",
            "10.0.0.1",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.1.1",
            "100.64.0.1",
            "198.18.0.1",
            "0.0.0.0",
            "224.0.0.1",
        ] {
            assert!(is_blocked_ip(value.parse().unwrap()), "{value}");
        }
        assert!(!is_blocked_ip("8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn blocks_ipv6_local_and_ipv4_mapped_private() {
        for value in ["::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"] {
            assert!(is_blocked_ip(value.parse().unwrap()), "{value}");
        }
        assert!(!is_blocked_ip("2606:4700:4700::1111".parse().unwrap()));
    }
}
