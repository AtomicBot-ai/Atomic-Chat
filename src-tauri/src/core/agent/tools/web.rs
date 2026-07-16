use std::time::Duration;

use reqwest::header::HeaderMap;
use reqwest::Method;
use serde_json::Value;

use super::http::request_guarded;
use super::{optional_usize, required_string, truncate, ToolContext, MAX_TOOL_OUTPUT_CHARS};
use crate::core::agent::types::ToolOutcome;

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
    let url = format!(
        "https://html.duckduckgo.com/html/?q={}",
        url::form_urlencoded::byte_serialize(query.as_bytes()).collect::<String>()
    );
    let response = request_guarded(
        Method::GET,
        &url,
        HeaderMap::new(),
        None,
        Duration::from_secs(30),
    )
    .await?;
    let html = response
        .text()
        .await
        .map_err(|error| ToolOutcome::error(error.to_string()))?;
    let text = html_to_text(&html);
    let lines = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .take(max_results.saturating_mul(4))
        .collect::<Vec<_>>()
        .join("\n");
    Ok(ToolOutcome::ok(truncate(lines, MAX_TOOL_OUTPUT_CHARS)))
}

async fn fetch(args: &Value, _context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let url = required_string(args, "url").map_err(ToolOutcome::error)?;
    let max_chars = optional_usize(args, "maxChars", 20_000, 100_000);
    let response = request_guarded(
        Method::GET,
        &url,
        HeaderMap::new(),
        None,
        Duration::from_secs(30),
    )
    .await?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let body = response
        .text()
        .await
        .map_err(|error| ToolOutcome::error(error.to_string()))?;
    if !status.is_success() {
        return Err(ToolOutcome::error(format!(
            "HTTP {}: {}",
            status,
            truncate(body, 2_000)
        )));
    }
    let output = if content_type.contains("html") {
        html_to_text(&body)
    } else {
        body
    };
    Ok(ToolOutcome::ok(truncate(output, max_chars)))
}

fn html_to_text(html: &str) -> String {
    let mut output = String::with_capacity(html.len());
    let mut in_tag = false;
    let mut previous_space = false;
    for character in html.chars() {
        match character {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                if !previous_space {
                    output.push('\n');
                    previous_space = true;
                }
            }
            _ if in_tag => {}
            '&' => {
                output.push(' ');
                previous_space = true;
            }
            value if value.is_whitespace() => {
                if !previous_space {
                    output.push(' ');
                    previous_space = true;
                }
            }
            value => {
                output.push(value);
                previous_space = false;
            }
        }
    }
    output
}
