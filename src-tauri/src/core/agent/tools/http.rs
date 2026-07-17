use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::header::{
    HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_LENGTH, CONTENT_TYPE, COOKIE,
    LOCATION, PROXY_AUTHORIZATION,
};
use reqwest::{Method, Response, StatusCode, Url};
use serde_json::Value;
use tokio::time::Instant;

use super::{required_string, truncate, ToolContext, MAX_TOOL_OUTPUT_CHARS};
use crate::core::agent::types::ToolOutcome;

const MAX_REDIRECTS: usize = 5;
const MAX_HTTP_RESPONSE_BYTES: usize = 2_000_000;

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
    let (body, response_truncated) = read_body_limited(response, MAX_HTTP_RESPONSE_BYTES).await?;
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
            "responseTruncated": response_truncated,
            "responseByteLimit": MAX_HTTP_RESPONSE_BYTES,
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
    let mut method = method;
    let mut headers = headers;
    let mut body = body;
    let deadline = Instant::now() + timeout;
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
            .body(body.clone().unwrap_or_default());
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| ToolOutcome::error("HTTP request timed out"))?;
        let response = response
            .timeout(remaining)
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
        apply_redirect_policy(
            response.status(),
            &url,
            &redirected,
            &mut method,
            &mut headers,
            &mut body,
        );
        url = redirected;
    }
    Err(ToolOutcome::error("HTTP redirect resolution failed"))
}

fn apply_redirect_policy(
    status: StatusCode,
    previous_url: &Url,
    redirected_url: &Url,
    method: &mut Method,
    headers: &mut HeaderMap,
    body: &mut Option<String>,
) {
    if (status == StatusCode::SEE_OTHER && *method != Method::HEAD)
        || (matches!(status, StatusCode::MOVED_PERMANENTLY | StatusCode::FOUND)
            && *method == Method::POST)
    {
        *method = Method::GET;
        *body = None;
        headers.remove(CONTENT_LENGTH);
        headers.remove(CONTENT_TYPE);
    }
    if !same_origin(previous_url, redirected_url) {
        headers.remove(AUTHORIZATION);
        headers.remove(PROXY_AUTHORIZATION);
        headers.remove(COOKIE);
    }
}

fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str().map(str::to_ascii_lowercase)
            == right.host_str().map(str::to_ascii_lowercase)
        && left.port_or_known_default() == right.port_or_known_default()
}

async fn read_body_limited(
    response: Response,
    max_bytes: usize,
) -> Result<(String, bool), ToolOutcome> {
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    let mut truncated = false;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk
            .map_err(|error| ToolOutcome::error(format!("Could not read response: {error}")))?;
        let remaining = max_bytes.saturating_sub(bytes.len());
        if chunk.len() > remaining {
            bytes.extend_from_slice(&chunk[..remaining]);
            truncated = true;
            break;
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((String::from_utf8_lossy(&bytes).into_owned(), truncated))
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

    #[test]
    fn post_redirect_to_get_drops_body_and_entity_headers() {
        let previous = Url::parse("https://example.com/start").unwrap();
        let redirected = Url::parse("https://example.com/final").unwrap();
        let mut method = Method::POST;
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert(CONTENT_LENGTH, HeaderValue::from_static("2"));
        let mut body = Some("{}".to_string());

        apply_redirect_policy(
            StatusCode::FOUND,
            &previous,
            &redirected,
            &mut method,
            &mut headers,
            &mut body,
        );

        assert_eq!(method, Method::GET);
        assert!(body.is_none());
        assert!(!headers.contains_key(CONTENT_TYPE));
        assert!(!headers.contains_key(CONTENT_LENGTH));
    }

    #[test]
    fn cross_origin_redirect_drops_credentials_but_preserves_307_body() {
        let previous = Url::parse("https://example.com/start").unwrap();
        let redirected = Url::parse("https://other.example/final").unwrap();
        let mut method = Method::POST;
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, HeaderValue::from_static("Bearer secret"));
        headers.insert(COOKIE, HeaderValue::from_static("session=secret"));
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        let mut body = Some("{}".to_string());

        apply_redirect_policy(
            StatusCode::TEMPORARY_REDIRECT,
            &previous,
            &redirected,
            &mut method,
            &mut headers,
            &mut body,
        );

        assert_eq!(method, Method::POST);
        assert_eq!(body.as_deref(), Some("{}"));
        assert!(!headers.contains_key(AUTHORIZATION));
        assert!(!headers.contains_key(COOKIE));
        assert!(headers.contains_key(CONTENT_TYPE));
    }
}
