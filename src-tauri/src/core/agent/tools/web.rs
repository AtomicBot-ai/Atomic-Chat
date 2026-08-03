use std::time::Duration;

use futures_util::StreamExt;
use reqwest::header::{
    HeaderMap, HeaderValue, ACCEPT, ACCEPT_LANGUAGE, CONTENT_LENGTH, CONTENT_TYPE, USER_AGENT,
};
use reqwest::Method;
use serde_json::Value;

use super::http::request_guarded;
use super::web_exa::{self, ExaFailure, ExaFetchContent};
use super::web_extract::{extract_web_content, ExtractMode};
use super::web_search::{parse_duckduckgo_page, DuckDuckGoPage, WebSearchResult};
use super::{optional_usize, required_string, truncate, ToolContext, MAX_TOOL_OUTPUT_CHARS};
use crate::core::agent::types::{ToolOutcome, ToolStatus};

const MAX_RESPONSE_BYTES: usize = 2_000_000;
const WEB_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

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
    match web_exa::search(&query, max_results).await {
        Ok(results) => Ok(search_outcome(&query, results, "exa", None, false)),
        Err(error) => annotate_fallback(
            search_duckduckgo(&query, max_results).await,
            "duckduckgo",
            error,
        ),
    }
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
        DuckDuckGoPage::Empty => Ok(ToolOutcome {
            status: ToolStatus::Ok,
            summary: "No search results found.".to_owned(),
            details: Some(serde_json::json!({
                "provider": "duckduckgo",
                "query": query,
                "results": [],
                "responseTruncated": response_truncated,
            })),
        }),
        DuckDuckGoPage::Results(results) => Ok(search_outcome(
            query,
            results,
            "duckduckgo",
            None,
            response_truncated,
        )),
    }
}

async fn fetch(args: &Value, _context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
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
    match web_exa::fetch(&url, max_chars).await {
        Ok(content) => Ok(exa_fetch_outcome(&url, content, extract_mode)),
        Err(error) => annotate_fallback(
            fetch_direct(&url, max_chars, extract_mode).await,
            "direct_http",
            error,
        ),
    }
}

async fn fetch_direct(
    url: &str,
    max_chars: usize,
    extract_mode: ExtractMode,
) -> Result<ToolOutcome, ToolOutcome> {
    let mut headers = browser_headers();
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("text/markdown,text/html;q=0.9,text/plain;q=0.8,*/*;q=0.5"),
    );
    let response =
        request_guarded(Method::GET, &url, headers, None, Duration::from_secs(30)).await?;
    let status = response.status();
    let final_url = response.url().to_string();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let (body, response_truncated) = read_body_limited(response, MAX_RESPONSE_BYTES).await?;
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

fn browser_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(WEB_USER_AGENT));
    headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.8"));
    headers
}

async fn read_body_limited(
    response: reqwest::Response,
    max_bytes: usize,
) -> Result<(String, bool), ToolOutcome> {
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
    Ok((String::from_utf8_lossy(&bytes).into_owned(), truncated))
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
