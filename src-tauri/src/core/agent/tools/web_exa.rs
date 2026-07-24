use std::time::Duration;

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, CONTENT_TYPE};
use reqwest::Method;
use serde_json::{json, Value};
use url::Url;

use super::http::request_guarded;
use super::web_search::WebSearchResult;

const EXA_MCP_URL: &str = "https://mcp.exa.ai/mcp";
const EXA_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_EXA_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct ExaFailure {
    reason: &'static str,
}

impl ExaFailure {
    pub(super) const fn new(reason: &'static str) -> Self {
        Self { reason }
    }

    pub(super) const fn reason(self) -> &'static str {
        self.reason
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct ExaFetchContent {
    pub text: String,
    pub title: Option<String>,
    pub truncated: bool,
}

pub(super) async fn search(
    query: &str,
    max_results: usize,
) -> Result<Vec<WebSearchResult>, ExaFailure> {
    let text = call_tool(
        "web_search_exa",
        json!({
            "query": query,
            "numResults": max_results,
        }),
    )
    .await?;
    let results = parse_search_results(&text, max_results);
    if results.is_empty() {
        Err(ExaFailure::new("empty_results"))
    } else {
        Ok(results)
    }
}

pub(super) async fn fetch(url: &str, max_characters: usize) -> Result<ExaFetchContent, ExaFailure> {
    let text = call_tool(
        "web_fetch_exa",
        json!({
            "urls": [url],
            "maxCharacters": max_characters,
        }),
    )
    .await?;
    parse_fetch_content(&text, max_characters).ok_or(ExaFailure::new("empty_content"))
}

async fn call_tool(name: &str, arguments: Value) -> Result<String, ExaFailure> {
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": name,
            "arguments": arguments,
        },
    })
    .to_string();
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("application/json, text/event-stream"),
    );
    let response = request_guarded(Method::POST, EXA_MCP_URL, headers, Some(body), EXA_TIMEOUT)
        .await
        .map_err(|_| ExaFailure::new("transport_error"))?;
    if !response.status().is_success() {
        return Err(ExaFailure::new("http_error"));
    }
    let body = read_body_limited(response).await?;
    extract_mcp_text(&body)
}

async fn read_body_limited(response: reqwest::Response) -> Result<String, ExaFailure> {
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ExaFailure::new("transport_error"))?;
        if body.len().saturating_add(chunk.len()) > MAX_EXA_RESPONSE_BYTES {
            return Err(ExaFailure::new("response_too_large"));
        }
        body.extend_from_slice(&chunk);
    }
    String::from_utf8(body).map_err(|_| ExaFailure::new("invalid_response"))
}

fn extract_mcp_text(body: &str) -> Result<String, ExaFailure> {
    let payloads = sse_payloads(body);
    let candidates = if payloads.is_empty() {
        vec![body.trim()]
    } else {
        payloads
    };
    let envelope = candidates
        .iter()
        .rev()
        .find_map(|payload| serde_json::from_str::<Value>(payload).ok())
        .ok_or(ExaFailure::new("invalid_response"))?;
    if envelope.get("error").is_some()
        || envelope
            .pointer("/result/isError")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        return Err(ExaFailure::new("mcp_error"));
    }
    let text = envelope
        .pointer("/result/content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|entry| entry.get("text").and_then(Value::as_str))
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    if text.is_empty() {
        Err(ExaFailure::new("empty_content"))
    } else {
        Ok(text)
    }
}

fn sse_payloads(body: &str) -> Vec<&str> {
    body.lines()
        .map(str::trim)
        .filter_map(|line| line.strip_prefix("data:").map(str::trim))
        .filter(|payload| !payload.is_empty() && *payload != "[DONE]")
        .collect()
}

fn parse_search_results(text: &str, max_results: usize) -> Vec<WebSearchResult> {
    split_result_blocks(text)
        .into_iter()
        .filter_map(|block| {
            let title = read_field(block, "Title")?;
            let url = read_field(block, "URL")?;
            let parsed_url = Url::parse(&url).ok()?;
            if !matches!(parsed_url.scheme(), "http" | "https") {
                return None;
            }
            Some(WebSearchResult {
                title,
                url,
                snippet: read_multiline_field(block, "Highlights")
                    .or_else(|| read_multiline_field(block, "Text"))
                    .unwrap_or_default(),
            })
        })
        .take(max_results)
        .collect()
}

fn split_result_blocks(text: &str) -> Vec<&str> {
    let mut blocks = Vec::new();
    let mut start = 0;
    for (index, _) in text.match_indices("\nTitle:") {
        if index > start {
            blocks.extend(split_horizontal_rules(&text[start..index]));
        }
        start = index + 1;
    }
    blocks.extend(split_horizontal_rules(&text[start..]));
    blocks
        .into_iter()
        .map(str::trim)
        .filter(|block| block.contains("Title:"))
        .collect()
}

fn split_horizontal_rules(text: &str) -> Vec<&str> {
    text.split("\n---\n").collect()
}

fn parse_fetch_content(text: &str, max_characters: usize) -> Option<ExaFetchContent> {
    let first = split_result_blocks(text)
        .into_iter()
        .next()
        .unwrap_or(text)
        .trim();
    let title = read_field(first, "Title");
    let content = read_multiline_field_raw(first, "Text")
        .or_else(|| read_multiline_field_raw(first, "Content"))
        .or_else(|| read_multiline_field_raw(first, "Highlights"))
        .unwrap_or_else(|| first.to_owned());
    let truncated = content.chars().count() > max_characters;
    let content = truncate_chars(content.trim(), max_characters);
    (!content.is_empty()).then_some(ExaFetchContent {
        text: content,
        title,
        truncated,
    })
}

fn read_field(block: &str, name: &str) -> Option<String> {
    let prefix = format!("{name}:");
    block.lines().find_map(|line| {
        line.trim()
            .strip_prefix(&prefix)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    })
}

fn read_multiline_field(block: &str, name: &str) -> Option<String> {
    read_multiline_field_raw(block, name)
        .map(|content| content.split_whitespace().collect::<Vec<_>>().join(" "))
}

fn read_multiline_field_raw(block: &str, name: &str) -> Option<String> {
    let prefix = format!("{name}:");
    let lines = block.lines().collect::<Vec<_>>();
    let start = lines
        .iter()
        .position(|line| line.trim().starts_with(&prefix))?;
    let first = lines[start].trim();
    let mut content = first
        .strip_prefix(&prefix)
        .map(str::trim)
        .unwrap_or_default()
        .to_owned();
    for line in &lines[start + 1..] {
        let trimmed = line.trim();
        if trimmed == "---" || is_metadata_field(trimmed) {
            break;
        }
        if !content.is_empty() {
            content.push('\n');
        }
        content.push_str(line);
    }
    let content = content.trim().to_owned();
    (!content.is_empty()).then_some(content)
}

fn is_metadata_field(line: &str) -> bool {
    [
        "Title:",
        "URL:",
        "Published:",
        "Author:",
        "Text:",
        "Content:",
        "Highlights:",
    ]
    .iter()
    .any(|prefix| line.starts_with(prefix))
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_text_from_json_rpc_and_sse_envelopes() {
        let json = r#"{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"alpha"},{"type":"text","text":"beta"}]}}"#;
        assert_eq!(extract_mcp_text(json).unwrap(), "alpha\n\nbeta");

        let sse = format!("event: message\ndata: {json}\n\ndata: [DONE]\n");
        assert_eq!(extract_mcp_text(&sse).unwrap(), "alpha\n\nbeta");
    }

    #[test]
    fn rejects_mcp_errors_malformed_and_empty_content() {
        let rpc_error = r#"{"jsonrpc":"2.0","id":1,"error":{"message":"secret payload"}}"#;
        assert_eq!(
            extract_mcp_text(rpc_error).unwrap_err().reason(),
            "mcp_error"
        );
        let tool_error = r#"{"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[]}}"#;
        assert_eq!(
            extract_mcp_text(tool_error).unwrap_err().reason(),
            "mcp_error"
        );
        assert_eq!(
            extract_mcp_text("not json").unwrap_err().reason(),
            "invalid_response"
        );
        assert_eq!(
            extract_mcp_text(r#"{"result":{"content":[]}}"#)
                .unwrap_err()
                .reason(),
            "empty_content"
        );
    }

    #[test]
    fn parses_search_results_and_enforces_limit() {
        let text = "Title: Alpha\nURL: https://example.com/a\nPublished: 2026-01-01\nHighlights:\nFirst result\n---\nTitle: Beta\nURL: https://example.com/b\nHighlights: Second result";
        let results = parse_search_results(text, 1);
        assert_eq!(
            results,
            vec![WebSearchResult {
                title: "Alpha".into(),
                url: "https://example.com/a".into(),
                snippet: "First result".into(),
            }]
        );
    }

    #[test]
    fn parses_fetch_markdown_and_enforces_character_limit() {
        let text = "Title: Example\nURL: https://example.com\nText:\n# Heading\nUseful body";
        assert_eq!(
            parse_fetch_content(text, 12),
            Some(ExaFetchContent {
                text: "# Heading\nUs".into(),
                title: Some("Example".into()),
                truncated: true,
            })
        );
    }
}
