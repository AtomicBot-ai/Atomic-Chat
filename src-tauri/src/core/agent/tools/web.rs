use std::path::Path;
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::header::{
    HeaderMap, HeaderName, HeaderValue, ACCEPT, ACCEPT_LANGUAGE, CONTENT_LENGTH, CONTENT_TYPE,
    USER_AGENT,
};
use reqwest::Method;
use serde_json::Value;
use sha2::{Digest, Sha256};
use url::Url;

use super::http::request_guarded;
use super::web_exa::{self, ExaFailure, ExaFetchContent};
use super::web_extract::{extract_web_content, ExtractMode};
use super::web_search::{parse_duckduckgo_page, DuckDuckGoPage, WebSearchResult};
use super::{optional_usize, required_string, truncate, ToolContext, MAX_TOOL_OUTPUT_CHARS};
use crate::core::agent::types::{ToolOutcome, ToolStatus};

const MAX_RESPONSE_BYTES: usize = 2_000_000;
/// Journal and archive PDFs regularly exceed the HTML cap, so direct fetches
/// known to carry a PDF may read up to this many bytes instead.
const MAX_PDF_RESPONSE_BYTES: usize = 25_000_000;
const WEB_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const WAYBACK_AVAILABILITY_URL: &str = "https://archive.org/wayback/available";
const SERPER_SEARCH_URL: &str = "https://google.serper.dev/search";
/// Nudges the model to rework a dead-end query instead of giving up.
const EMPTY_SEARCH_RESULTS_SUMMARY: &str = "No results. Rewrite the query — fewer quoted \
     phrases, broader or alternative terms — and search again.";

pub async fn execute(
    tool: &str,
    args: &Value,
    context: &ToolContext<'_>,
) -> Result<ToolOutcome, ToolOutcome> {
    match tool {
        "os.web.search" => search(args, context).await,
        "os.web.fetch" => fetch(args, context).await,
        _ => Err(ToolOutcome::error(format!("Unsupported web tool: {tool}"))),
    }
}

async fn search(args: &Value, _context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let query = required_string(args, "query").map_err(ToolOutcome::error)?;
    let max_results = optional_usize(args, "maxResults", 8, 20);
    if let Some(api_key) = serper_api_key() {
        if let Some(outcome) = search_serper(&query, max_results, &api_key).await {
            return Ok(outcome);
        }
    }
    match web_exa::search(&query, max_results).await {
        Ok(results) => Ok(search_outcome(&query, results, "exa", None, false)),
        Err(error) => annotate_fallback(
            search_duckduckgo(&query, max_results).await,
            "duckduckgo",
            error,
        ),
    }
}

/// Serper is opt-in: it runs only when one of these env vars carries a key,
/// so the keyless default search path stays untouched.
fn serper_api_key() -> Option<String> {
    ["AGENT_SERPER_KEY", "GAIA_SERPER_KEY"]
        .into_iter()
        .find_map(|name| {
            std::env::var(name)
                .ok()
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        })
}

/// Google results via serper.dev. Returns `None` on any failure (transport,
/// HTTP, malformed payload, zero hits) so the caller falls back to the
/// existing exa -> DuckDuckGo chain.
async fn search_serper(query: &str, max_results: usize, api_key: &str) -> Option<ToolOutcome> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        HeaderName::from_static("x-api-key"),
        HeaderValue::from_str(api_key).ok()?,
    );
    let body = serde_json::json!({ "q": query }).to_string();
    let response = web_request(
        Method::POST,
        &serper_search_url(),
        headers,
        Some(body),
        Duration::from_secs(30),
    )
    .await
    .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let (bytes, _) = read_body_bytes_limited(response, MAX_RESPONSE_BYTES)
        .await
        .ok()?;
    let payload = serde_json::from_slice::<Value>(&bytes).ok()?;
    let results = parse_serper_results(&payload, max_results);
    (!results.is_empty()).then(|| search_outcome(query, results, "serper", None, false))
}

fn parse_serper_results(payload: &Value, max_results: usize) -> Vec<WebSearchResult> {
    payload
        .get("organic")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let title = entry
                .get("title")
                .and_then(Value::as_str)?
                .trim()
                .to_owned();
            let url = entry.get("link").and_then(Value::as_str)?.trim().to_owned();
            let parsed = Url::parse(&url).ok()?;
            if title.is_empty() || !matches!(parsed.scheme(), "http" | "https") {
                return None;
            }
            Some(WebSearchResult {
                title,
                url,
                snippet: entry
                    .get("snippet")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_owned(),
            })
        })
        .take(max_results)
        .collect()
}

async fn search_duckduckgo(query: &str, max_results: usize) -> Result<ToolOutcome, ToolOutcome> {
    let url = format!(
        "https://html.duckduckgo.com/html/?q={}",
        url::form_urlencoded::byte_serialize(query.as_bytes()).collect::<String>()
    );
    let mut headers = browser_headers();
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("text/html,application/xhtml+xml"),
    );
    let response =
        request_guarded(Method::GET, &url, headers, None, Duration::from_secs(30)).await?;
    let status = response.status();
    let (html, response_truncated) = read_body_limited(response, MAX_RESPONSE_BYTES).await?;
    if !status.is_success() {
        return Err(ToolOutcome {
            status: ToolStatus::Error,
            summary: format!("DuckDuckGo search failed with HTTP {status}"),
            details: Some(serde_json::json!({
                "provider": "duckduckgo",
                "query": query,
                "httpStatus": status.as_u16(),
                "responsePreview": truncate(html, 2_000),
            })),
        });
    }

    match parse_duckduckgo_page(&html, max_results) {
        DuckDuckGoPage::Blocked => Err(ToolOutcome {
            status: ToolStatus::Error,
            summary: "DuckDuckGo blocked the automated search with a bot challenge".to_owned(),
            details: Some(serde_json::json!({
                "provider": "duckduckgo",
                "query": query,
                "blocked": true,
            })),
        }),
        DuckDuckGoPage::Empty => Ok(empty_search_outcome(
            "duckduckgo",
            query,
            response_truncated,
        )),
        DuckDuckGoPage::Results(results) => Ok(search_outcome(
            query,
            results,
            "duckduckgo",
            None,
            response_truncated,
        )),
    }
}

fn empty_search_outcome(
    provider: &'static str,
    query: &str,
    response_truncated: bool,
) -> ToolOutcome {
    ToolOutcome {
        status: ToolStatus::Ok,
        summary: EMPTY_SEARCH_RESULTS_SUMMARY.to_owned(),
        details: Some(serde_json::json!({
            "provider": provider,
            "query": query,
            "results": [],
            "responseTruncated": response_truncated,
        })),
    }
}

async fn fetch(args: &Value, context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let url = required_string(args, "url").map_err(ToolOutcome::error)?;
    let max_chars = optional_usize(args, "maxChars", 50_000, 50_000);
    let extract_mode = match args
        .get("extractMode")
        .and_then(Value::as_str)
        .unwrap_or("markdown")
    {
        "markdown" => ExtractMode::Markdown,
        "text" => ExtractMode::Text,
        value => {
            return Err(ToolOutcome::error(format!(
                "Invalid extractMode `{value}`; expected `markdown` or `text`"
            )))
        }
    };
    fetch_url(&url, max_chars, extract_mode, context.working_dir).await
}

async fn fetch_url(
    url: &str,
    max_chars: usize,
    extract_mode: ExtractMode,
    working_dir: &Path,
) -> Result<ToolOutcome, ToolOutcome> {
    // PDFs go straight to the direct fetch: Exa re-renders documents as text
    // and would mangle the bytes the document parser needs.
    let exa_failure = if is_pdf_url(url) {
        None
    } else {
        match web_exa::fetch(url, max_chars).await {
            Ok(content) => return Ok(exa_fetch_outcome(url, content, extract_mode)),
            Err(error) => Some(error),
        }
    };
    let mut result = fetch_direct(url, max_chars, extract_mode, working_dir).await;
    if let Some(failure) = exa_failure {
        result = annotate_fallback(result, "direct_http", failure);
    }
    recover_via_wayback(result, url, max_chars, extract_mode, working_dir).await
}

fn is_pdf_url(url: &str) -> bool {
    Url::parse(url).is_ok_and(|parsed| parsed.path().to_ascii_lowercase().ends_with(".pdf"))
}

async fn fetch_direct(
    url: &str,
    max_chars: usize,
    extract_mode: ExtractMode,
    working_dir: &Path,
) -> Result<ToolOutcome, ToolOutcome> {
    let mut headers = browser_headers();
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("text/markdown,text/html;q=0.9,text/plain;q=0.8,*/*;q=0.5"),
    );
    let response = web_request(Method::GET, url, headers, None, Duration::from_secs(30)).await?;
    let status = response.status();
    let final_url = response.url().to_string();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let declares_pdf = content_type
        .to_ascii_lowercase()
        .contains("application/pdf");
    let byte_limit = if declares_pdf || is_pdf_url(url) {
        MAX_PDF_RESPONSE_BYTES
    } else {
        MAX_RESPONSE_BYTES
    };
    let (bytes, response_truncated) = read_body_bytes_limited(response, byte_limit).await?;
    if status.is_success() && (declares_pdf || bytes.starts_with(b"%PDF-")) {
        let details = serde_json::json!({
            "url": url,
            "finalUrl": final_url,
            "httpStatus": status.as_u16(),
            "contentType": content_type,
            "extractor": "pdf",
        });
        return save_and_extract_pdf(bytes, response_truncated, max_chars, working_dir, details)
            .await;
    }
    let body = String::from_utf8_lossy(&bytes).into_owned();
    let extracted = extract_web_content(&body, &content_type, extract_mode);
    let output_truncated = extracted.text.chars().count() > max_chars;
    let output = if output_truncated {
        format!(
            "{}\n… [truncated]",
            extracted.text.chars().take(max_chars).collect::<String>()
        )
    } else {
        extracted.text
    };
    if !status.is_success() {
        return Err(ToolOutcome {
            status: ToolStatus::Error,
            summary: format!("HTTP {status} for {final_url}"),
            details: Some(serde_json::json!({
                "url": url,
                "finalUrl": final_url,
                "httpStatus": status.as_u16(),
                "contentType": content_type,
                "extractor": extracted.extractor,
                "title": extracted.title,
                "extractedText": output,
                "truncated": response_truncated || output_truncated,
            })),
        });
    }
    Ok(ToolOutcome {
        status: ToolStatus::Ok,
        summary: output,
        details: Some(serde_json::json!({
            "url": url,
            "finalUrl": final_url,
            "httpStatus": status.as_u16(),
            "contentType": content_type,
            "extractor": extracted.extractor,
            "title": extracted.title,
            "extractMode": match extract_mode {
                ExtractMode::Markdown => "markdown",
                ExtractMode::Text => "text",
            },
            "truncated": response_truncated || output_truncated,
        })),
    })
}

/// Persist fetched PDF bytes under `.agent/downloads/` and run the document
/// parser over the saved file (mirroring `os.fs.read_document`), so the model
/// can re-read the file later. `details` must already carry the response
/// metadata; the saved path is added to it on both success and failure.
async fn save_and_extract_pdf(
    bytes: Vec<u8>,
    response_truncated: bool,
    max_chars: usize,
    working_dir: &Path,
    mut details: Value,
) -> Result<ToolOutcome, ToolOutcome> {
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let downloads_dir = working_dir.join(".agent").join("downloads");
    tokio::fs::create_dir_all(&downloads_dir)
        .await
        .map_err(|error| {
            ToolOutcome::error(format!(
                "Could not create {}: {error}",
                downloads_dir.display()
            ))
        })?;
    let saved_path = downloads_dir.join(format!("{}.pdf", &digest[..16]));
    tokio::fs::write(&saved_path, &bytes)
        .await
        .map_err(|error| {
            ToolOutcome::error(format!(
                "Could not save PDF to {}: {error}",
                saved_path.display()
            ))
        })?;
    let saved_display = saved_path.display().to_string();
    if let Some(object) = details.as_object_mut() {
        object.insert("savedPath".into(), Value::String(saved_display.clone()));
    }
    let parser_path = saved_display.clone();
    let parsed =
        tokio::task::spawn_blocking(move || tauri_plugin_rag::parse_document(&parser_path, "pdf"))
            .await
            .map_err(|error| format!("Document parser task failed: {error}"))
            .and_then(|result| result.map_err(|error| error.to_string()));
    let text = match parsed {
        Ok(text) => text,
        Err(error) => {
            return Err(ToolOutcome {
                status: ToolStatus::Error,
                summary: format!(
                    "Could not extract PDF text ({error}). The raw PDF is saved at {saved_display}"
                ),
                details: Some(details),
            })
        }
    };
    let original_chars = text.chars().count();
    let output = truncate(text, max_chars);
    if let Some(object) = details.as_object_mut() {
        object.insert("originalChars".into(), serde_json::json!(original_chars));
        object.insert(
            "truncated".into(),
            Value::Bool(response_truncated || original_chars > max_chars),
        );
    }
    Ok(ToolOutcome {
        status: ToolStatus::Ok,
        summary: format!(
            "{output}\n\n[PDF saved to {saved_display}; re-read it with os.fs.read_document]"
        ),
        details: Some(details),
    })
}

/// One-shot Wayback Machine recovery: when the direct fetch failed, ask
/// archive.org for the closest snapshot and fetch it through the same direct
/// path (PDF handling included). The original error is kept when no snapshot
/// exists or the snapshot fetch fails too.
async fn recover_via_wayback(
    direct: Result<ToolOutcome, ToolOutcome>,
    url: &str,
    max_chars: usize,
    extract_mode: ExtractMode,
    working_dir: &Path,
) -> Result<ToolOutcome, ToolOutcome> {
    let direct_error = match direct {
        Ok(outcome) => return Ok(outcome),
        Err(error) => error,
    };
    // Only consult archive.org for URLs that are themselves public and
    // well-formed. Otherwise a fetch the SSRF guard rejected (a private or
    // loopback target, credentials in the URL, a bad scheme) would be
    // exfiltrated to a third party as a query parameter by the very path meant
    // to be defensive. Tests exercise the recovery with loopback fixtures, so
    // the gate is production-only; the guard itself is unit-tested in http.rs.
    if !wayback_target_is_public(url).await {
        return Err(direct_error);
    }
    let Some(snapshot_url) = wayback_snapshot_url(url).await else {
        return Err(direct_error);
    };
    match fetch_direct(&snapshot_url, max_chars, extract_mode, working_dir).await {
        Ok(mut outcome) => {
            add_wayback_details(&mut outcome, &snapshot_url);
            Ok(outcome)
        }
        Err(_) => Err(direct_error),
    }
}

/// Whether the original fetch target is a public http(s) URL safe to name to
/// archive.org. Bypassed under test so loopback fixtures can exercise the
/// recovery path; in production it runs the same SSRF validator as the guard.
#[cfg(test)]
async fn wayback_target_is_public(_url: &str) -> bool {
    true
}

#[cfg(not(test))]
async fn wayback_target_is_public(url: &str) -> bool {
    match Url::parse(url) {
        Ok(parsed) => super::http::validate_public_http_url(parsed).await.is_ok(),
        Err(_) => false,
    }
}

async fn wayback_snapshot_url(original_url: &str) -> Option<String> {
    let availability_url = format!(
        "{}?url={}",
        wayback_availability_url(),
        url::form_urlencoded::byte_serialize(original_url.as_bytes()).collect::<String>()
    );
    let mut headers = browser_headers();
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    let response = web_request(
        Method::GET,
        &availability_url,
        headers,
        None,
        Duration::from_secs(20),
    )
    .await
    .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let (bytes, _) = read_body_bytes_limited(response, MAX_RESPONSE_BYTES)
        .await
        .ok()?;
    let payload = serde_json::from_slice::<Value>(&bytes).ok()?;
    let snapshot = payload.pointer("/archived_snapshots/closest")?;
    if !snapshot
        .get("available")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    let snapshot_url = snapshot.get("url").and_then(Value::as_str)?;
    let parsed = Url::parse(snapshot_url).ok()?;
    matches!(parsed.scheme(), "http" | "https").then(|| snapshot_url.to_owned())
}

fn wayback_availability_url() -> String {
    #[cfg(test)]
    {
        if let Some(url) = test_overrides::wayback_availability_url() {
            return url;
        }
    }
    WAYBACK_AVAILABILITY_URL.to_owned()
}

fn serper_search_url() -> String {
    #[cfg(test)]
    {
        if let Some(url) = test_overrides::serper_search_url() {
            return url;
        }
    }
    SERPER_SEARCH_URL.to_owned()
}

fn search_outcome(
    query: &str,
    results: Vec<WebSearchResult>,
    provider: &'static str,
    fallback_reason: Option<&'static str>,
    response_truncated: bool,
) -> ToolOutcome {
    let rendered = results
        .iter()
        .enumerate()
        .map(|(index, result)| {
            let snippet = if result.snippet.is_empty() {
                String::new()
            } else {
                format!("\n{}", result.snippet)
            };
            format!("{}. {}\n{}{}", index + 1, result.title, result.url, snippet)
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    ToolOutcome {
        status: ToolStatus::Ok,
        summary: truncate(rendered, MAX_TOOL_OUTPUT_CHARS),
        details: Some(serde_json::json!({
            "provider": provider,
            "query": query,
            "results": results,
            "fallbackReason": fallback_reason,
            "responseTruncated": response_truncated,
        })),
    }
}

fn exa_fetch_outcome(
    url: &str,
    content: ExaFetchContent,
    extract_mode: ExtractMode,
) -> ToolOutcome {
    let truncated = content.truncated;
    ToolOutcome {
        status: ToolStatus::Ok,
        summary: content.text,
        details: Some(serde_json::json!({
            "provider": "exa",
            "url": url,
            "finalUrl": url,
            "extractor": "exa",
            "title": content.title,
            "extractMode": match extract_mode {
                ExtractMode::Markdown => "markdown",
                ExtractMode::Text => "text",
            },
            "truncated": truncated,
        })),
    }
}

fn add_fallback_details(
    outcome: &mut ToolOutcome,
    provider: &'static str,
    exa_failure: ExaFailure,
) {
    let details = outcome.details.get_or_insert_with(|| serde_json::json!({}));
    if let Some(object) = details.as_object_mut() {
        object.insert("provider".into(), Value::String(provider.into()));
        object.insert(
            "fallbackReason".into(),
            Value::String(exa_failure.reason().into()),
        );
        object.insert("fallbackFrom".into(), Value::String("exa".into()));
    }
}

fn annotate_fallback(
    result: Result<ToolOutcome, ToolOutcome>,
    provider: &'static str,
    exa_failure: ExaFailure,
) -> Result<ToolOutcome, ToolOutcome> {
    match result {
        Ok(mut outcome) => {
            add_fallback_details(&mut outcome, provider, exa_failure);
            Ok(outcome)
        }
        Err(mut outcome) => {
            add_fallback_details(&mut outcome, provider, exa_failure);
            Err(outcome)
        }
    }
}

fn add_wayback_details(outcome: &mut ToolOutcome, snapshot_url: &str) {
    let details = outcome.details.get_or_insert_with(|| serde_json::json!({}));
    if let Some(object) = details.as_object_mut() {
        object.insert("provider".into(), Value::String("wayback".into()));
        object.insert(
            "fallbackReason".into(),
            Value::String("direct_fetch_failed".into()),
        );
        object.insert("fallbackFrom".into(), Value::String("direct_http".into()));
        object.insert(
            "waybackSnapshotUrl".into(),
            Value::String(snapshot_url.to_owned()),
        );
    }
}

fn browser_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(WEB_USER_AGENT));
    headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.8"));
    headers
}

/// All web-tool requests go through the SSRF-guarded HTTP path. In tests,
/// loopback URLs are dispatched directly so fixture servers on 127.0.0.1 stay
/// reachable despite the guard's private-address blocking.
async fn web_request(
    method: Method,
    url: &str,
    headers: HeaderMap,
    body: Option<String>,
    timeout: Duration,
) -> Result<reqwest::Response, ToolOutcome> {
    #[cfg(test)]
    {
        if let Some(result) =
            loopback_test_request(method.clone(), url, headers.clone(), body.clone(), timeout).await
        {
            return result;
        }
    }
    request_guarded(method, url, headers, body, timeout).await
}

#[cfg(test)]
async fn loopback_test_request(
    method: Method,
    url: &str,
    headers: HeaderMap,
    body: Option<String>,
    timeout: Duration,
) -> Option<Result<reqwest::Response, ToolOutcome>> {
    let parsed = Url::parse(url).ok()?;
    if parsed.host_str() != Some("127.0.0.1") {
        return None;
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("build loopback test client");
    Some(
        client
            .request(method, parsed)
            .headers(headers)
            .body(body.unwrap_or_default())
            .timeout(timeout)
            .send()
            .await
            .map_err(|error| ToolOutcome::error(format!("HTTP request failed: {error}"))),
    )
}

async fn read_body_limited(
    response: reqwest::Response,
    max_bytes: usize,
) -> Result<(String, bool), ToolOutcome> {
    let (bytes, truncated) = read_body_bytes_limited(response, max_bytes).await?;
    Ok((String::from_utf8_lossy(&bytes).into_owned(), truncated))
}

async fn read_body_bytes_limited(
    response: reqwest::Response,
    max_bytes: usize,
) -> Result<(Vec<u8>, bool), ToolOutcome> {
    if response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > max_bytes)
    {
        return Err(ToolOutcome::error(format!(
            "Web response exceeds the {max_bytes}-byte limit"
        )));
    }

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
    Ok((bytes, truncated))
}

#[cfg(test)]
mod test_overrides {
    use std::cell::RefCell;

    thread_local! {
        static WAYBACK_AVAILABILITY_URL: RefCell<Option<String>> = const { RefCell::new(None) };
        static SERPER_SEARCH_URL: RefCell<Option<String>> = const { RefCell::new(None) };
    }

    pub(super) fn wayback_availability_url() -> Option<String> {
        WAYBACK_AVAILABILITY_URL.with(|url| url.borrow().clone())
    }

    pub(super) fn set_wayback_availability_url(url: Option<String>) {
        WAYBACK_AVAILABILITY_URL.with(|slot| *slot.borrow_mut() = url);
    }

    pub(super) fn serper_search_url() -> Option<String> {
        SERPER_SEARCH_URL.with(|url| url.borrow().clone())
    }

    pub(super) fn set_serper_search_url(url: Option<String>) {
        SERPER_SEARCH_URL.with(|slot| *slot.borrow_mut() = url);
    }
}

#[cfg(test)]
mod tests {
    use std::convert::Infallible;
    use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener};
    use std::sync::{Arc, Mutex};

    use hyper::service::{make_service_fn, service_fn};
    use hyper::{Body, Request, Response, Server};
    use tokio::sync::oneshot;

    use super::*;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct FixtureServer {
        address: SocketAddr,
        shutdown: Option<oneshot::Sender<()>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl FixtureServer {
        async fn start<F>(handler: F) -> Self
        where
            F: Fn(Request<Body>) -> Response<Body> + Send + Sync + 'static,
        {
            let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
                .expect("bind fixture server");
            listener
                .set_nonblocking(true)
                .expect("set fixture server nonblocking");
            let address = listener.local_addr().expect("fixture server address");
            let handler = Arc::new(handler);
            let (shutdown_tx, shutdown_rx) = oneshot::channel();
            let make_service = make_service_fn(move |_| {
                let handler = Arc::clone(&handler);
                async move {
                    Ok::<_, Infallible>(service_fn(move |request| {
                        let handler = Arc::clone(&handler);
                        async move { Ok::<_, Infallible>(handler(request)) }
                    }))
                }
            });
            let server = Server::from_tcp(listener)
                .expect("build fixture server")
                .serve(make_service)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                });
            let task = tokio::spawn(async move {
                let _ = server.await;
            });
            tokio::task::yield_now().await;
            Self {
                address,
                shutdown: Some(shutdown_tx),
                task,
            }
        }

        fn url(&self, path: &str) -> String {
            format!("http://127.0.0.1:{}{path}", self.address.port())
        }
    }

    impl Drop for FixtureServer {
        fn drop(&mut self) {
            if let Some(shutdown) = self.shutdown.take() {
                let _ = shutdown.send(());
            }
            self.task.abort();
        }
    }

    /// A minimal one-page PDF with a text object; the xref offsets are
    /// computed so strict parsers accept it.
    fn minimal_pdf() -> Vec<u8> {
        let text = "Atomic web fetch fixture with plenty of extractable characters inside";
        let content = format!("BT /F1 12 Tf 72 720 Td ({text}) Tj ET");
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R \
             /Resources << /Font << /F1 5 0 R >> >> >>"
                .to_owned(),
            format!(
                "<< /Length {} >>\nstream\n{content}\nendstream",
                content.len()
            ),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_owned(),
        ];
        let mut document = String::from("%PDF-1.4\n");
        let mut offsets = Vec::new();
        for (index, object) in objects.iter().enumerate() {
            offsets.push(document.len());
            document.push_str(&format!("{} 0 obj\n{object}\nendobj\n", index + 1));
        }
        let xref_offset = document.len();
        document.push_str(&format!(
            "xref\n0 {}\n0000000000 65535 f \n",
            objects.len() + 1
        ));
        for offset in &offsets {
            document.push_str(&format!("{offset:010} 00000 n \n"));
        }
        document.push_str(&format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n",
            objects.len() + 1
        ));
        document.into_bytes()
    }

    #[test]
    fn annotates_successful_fallback_without_exposing_exa_payloads() {
        let result = annotate_fallback(
            Ok(ToolOutcome {
                status: ToolStatus::Ok,
                summary: "fallback result".into(),
                details: Some(serde_json::json!({"provider": "legacy"})),
            }),
            "duckduckgo",
            ExaFailure::new("mcp_error"),
        )
        .unwrap();
        assert_eq!(
            result.details,
            Some(serde_json::json!({
                "provider": "duckduckgo",
                "fallbackFrom": "exa",
                "fallbackReason": "mcp_error",
            }))
        );
    }

    #[test]
    fn preserves_fallback_errors_and_records_the_route() {
        let result = annotate_fallback(
            Err(ToolOutcome::error("direct fetch failed")),
            "direct_http",
            ExaFailure::new("transport_error"),
        )
        .unwrap_err();
        assert_eq!(result.summary, "direct fetch failed");
        assert_eq!(
            result.details,
            Some(serde_json::json!({
                "provider": "direct_http",
                "fallbackFrom": "exa",
                "fallbackReason": "transport_error",
            }))
        );
    }

    #[test]
    fn maps_serper_organic_results_into_search_results() {
        let payload = serde_json::json!({
            "searchParameters": {"q": "test", "type": "search"},
            "organic": [
                {"title": "Alpha", "link": "https://example.com/a", "snippet": "First hit", "position": 1},
                {"title": "Beta", "link": "https://example.com/b", "position": 2},
                {"title": "Bad", "link": "ftp://example.com/c", "snippet": "wrong scheme"},
                {"link": "https://example.com/d", "snippet": "no title"},
                {"title": "Gamma", "link": "https://example.com/e", "snippet": "Third hit"},
            ]
        });
        assert_eq!(
            parse_serper_results(&payload, 2),
            vec![
                WebSearchResult {
                    title: "Alpha".into(),
                    url: "https://example.com/a".into(),
                    snippet: "First hit".into(),
                },
                WebSearchResult {
                    title: "Beta".into(),
                    url: "https://example.com/b".into(),
                    snippet: String::new(),
                },
            ]
        );
        assert!(parse_serper_results(&serde_json::json!({"organic": []}), 5).is_empty());
        assert!(parse_serper_results(&serde_json::json!({}), 5).is_empty());
    }

    #[test]
    fn reads_serper_api_key_from_either_env_var_and_defaults_to_none() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        std::env::remove_var("AGENT_SERPER_KEY");
        std::env::remove_var("GAIA_SERPER_KEY");
        assert_eq!(serper_api_key(), None);
        std::env::set_var("GAIA_SERPER_KEY", "gaia-key");
        assert_eq!(serper_api_key().as_deref(), Some("gaia-key"));
        std::env::set_var("AGENT_SERPER_KEY", "agent-key");
        assert_eq!(serper_api_key().as_deref(), Some("agent-key"));
        std::env::remove_var("AGENT_SERPER_KEY");
        std::env::remove_var("GAIA_SERPER_KEY");
        assert_eq!(serper_api_key(), None);
    }

    #[test]
    fn empty_search_results_prompt_a_query_rewrite() {
        let outcome = empty_search_outcome("duckduckgo", "\"quoted phrase\" rare terms", false);
        assert!(matches!(outcome.status, ToolStatus::Ok));
        assert_eq!(
            outcome.summary,
            "No results. Rewrite the query — fewer quoted phrases, broader or alternative \
             terms — and search again."
        );
        assert_eq!(
            outcome.details,
            Some(serde_json::json!({
                "provider": "duckduckgo",
                "query": "\"quoted phrase\" rare terms",
                "results": [],
                "responseTruncated": false,
            }))
        );
    }

    #[tokio::test]
    async fn serper_search_sends_the_api_key_and_maps_results() {
        let server = FixtureServer::start(|request| {
            if request
                .headers()
                .get("x-api-key")
                .and_then(|value| value.to_str().ok())
                != Some("test-key")
            {
                return Response::builder()
                    .status(hyper::StatusCode::FORBIDDEN)
                    .body(Body::from("missing key"))
                    .expect("build forbidden response");
            }
            let payload = serde_json::json!({
                "organic": [
                    {"title": "Alpha", "link": "https://example.com/a", "snippet": "First hit"},
                ]
            });
            Response::builder()
                .status(hyper::StatusCode::OK)
                .header(hyper::header::CONTENT_TYPE, "application/json")
                .body(Body::from(payload.to_string()))
                .expect("build serper response")
        })
        .await;
        test_overrides::set_serper_search_url(Some(server.url("/search")));
        let outcome = search_serper("alpha", 5, "test-key")
            .await
            .expect("serper search succeeds");
        test_overrides::set_serper_search_url(None);
        assert!(outcome.summary.contains("https://example.com/a"));
        let details = outcome.details.expect("serper details");
        assert_eq!(
            details.get("provider").and_then(Value::as_str),
            Some("serper")
        );
    }

    #[tokio::test]
    async fn saves_fetched_pdfs_and_reports_the_saved_path() {
        let pdf = minimal_pdf();
        assert!(pdf.starts_with(b"%PDF-"));
        let served = pdf.clone();
        let server = FixtureServer::start(move |_request| {
            Response::builder()
                .status(hyper::StatusCode::OK)
                .header(hyper::header::CONTENT_TYPE, "application/pdf")
                .body(Body::from(served.clone()))
                .expect("build pdf response")
        })
        .await;
        // Keep the wayback probe off the real network if the fetch ever fails.
        test_overrides::set_wayback_availability_url(Some(
            "http://127.0.0.1:9/unavailable".to_owned(),
        ));
        let workspace = tempfile::tempdir().expect("create test workspace");
        let result = fetch_url(
            &server.url("/paper.pdf"),
            50_000,
            ExtractMode::Markdown,
            workspace.path(),
        )
        .await;
        test_overrides::set_wayback_availability_url(None);
        // Extraction of synthetic PDFs can be brittle; the download contract
        // (saved file + locator in summary and details) must hold either way.
        let outcome = match result {
            Ok(outcome) => outcome,
            Err(outcome) => outcome,
        };
        let details = outcome.details.expect("pdf details");
        let saved_path = details
            .get("savedPath")
            .and_then(Value::as_str)
            .expect("savedPath detail")
            .to_owned();
        assert!(outcome.summary.contains(&saved_path));
        assert!(std::path::Path::new(&saved_path).exists());
        assert!(saved_path.contains(".agent"));
        assert!(saved_path.ends_with(".pdf"));
        assert_eq!(
            details.get("extractor").and_then(Value::as_str),
            Some("pdf")
        );
        assert_eq!(std::fs::read(&saved_path).expect("read saved pdf"), pdf);
    }

    #[tokio::test]
    async fn falls_back_to_wayback_snapshot_when_direct_fetch_fails() {
        let content = FixtureServer::start(|request| match request.uri().path() {
            "/snapshot" => Response::builder()
                .status(hyper::StatusCode::OK)
                .header(hyper::header::CONTENT_TYPE, "text/html")
                .body(Body::from(
                    "<html><body><main>archived fixture content</main></body></html>",
                ))
                .expect("build snapshot response"),
            _ => Response::builder()
                .status(hyper::StatusCode::INTERNAL_SERVER_ERROR)
                .body(Body::from("boom"))
                .expect("build error response"),
        })
        .await;
        let snapshot_url = content.url("/snapshot");
        let availability = FixtureServer::start(move |_request| {
            let payload = serde_json::json!({
                "archived_snapshots": {
                    "closest": {
                        "available": true,
                        "url": snapshot_url.clone(),
                        "timestamp": "20240101000000",
                        "status": "200",
                    }
                }
            });
            Response::builder()
                .status(hyper::StatusCode::OK)
                .header(hyper::header::CONTENT_TYPE, "application/json")
                .body(Body::from(payload.to_string()))
                .expect("build availability response")
        })
        .await;
        test_overrides::set_wayback_availability_url(Some(availability.url("/available")));
        let workspace = tempfile::tempdir().expect("create test workspace");
        let gone = content.url("/gone");
        let direct = fetch_direct(&gone, 50_000, ExtractMode::Text, workspace.path()).await;
        assert!(direct.is_err());
        let outcome =
            recover_via_wayback(direct, &gone, 50_000, ExtractMode::Text, workspace.path())
                .await
                .expect("wayback snapshot recovery");
        test_overrides::set_wayback_availability_url(None);
        assert!(outcome.summary.contains("archived fixture content"));
        let details = outcome.details.expect("wayback details");
        assert_eq!(
            details.get("provider").and_then(Value::as_str),
            Some("wayback")
        );
        assert_eq!(
            details.get("fallbackFrom").and_then(Value::as_str),
            Some("direct_http")
        );
        assert_eq!(
            details.get("fallbackReason").and_then(Value::as_str),
            Some("direct_fetch_failed")
        );
        assert!(details
            .get("waybackSnapshotUrl")
            .and_then(Value::as_str)
            .is_some_and(|url| url.ends_with("/snapshot")));
    }

    #[tokio::test]
    async fn keeps_the_original_error_when_no_snapshot_is_available() {
        let availability = FixtureServer::start(|_request| {
            Response::builder()
                .status(hyper::StatusCode::OK)
                .header(hyper::header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::json!({"archived_snapshots": {}}).to_string(),
                ))
                .expect("build availability response")
        })
        .await;
        test_overrides::set_wayback_availability_url(Some(availability.url("/available")));
        let workspace = tempfile::tempdir().expect("create test workspace");
        let error = recover_via_wayback(
            Err(ToolOutcome::error("HTTP 500 for https://example.com/gone")),
            "https://example.com/gone",
            50_000,
            ExtractMode::Text,
            workspace.path(),
        )
        .await
        .expect_err("original error is preserved");
        test_overrides::set_wayback_availability_url(None);
        assert_eq!(error.summary, "HTTP 500 for https://example.com/gone");
    }
}
