use futures_util::StreamExt;
use std::collections::HashMap;
use tauri::ipc::Channel;

#[derive(serde::Serialize, Clone)]
pub struct HttpStreamChunk {
    pub data: String,
}

/// Simple non-streaming HTTP POST that returns the full response body as text.
/// Bypasses tauri_plugin_http's fetch interception which may not properly
/// deliver response bodies to the webview.
#[tauri::command]
pub async fn post_local_http(
    url: String,
    headers: HashMap<String, String>,
    body: String,
    timeout_secs: u64,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(timeout_secs))
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .no_proxy()
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let mut req = client.post(&url);
    for (k, v) in &headers {
        req = req.header(k.as_str(), v.as_str());
    }
    req = req.body(body);

    let response = req.send().await.map_err(|e| format!("Request failed: {e}"))?;
    let status = response.status().as_u16();
    let text = response.text().await.map_err(|e| format!("Body read failed: {e}"))?;

    if status >= 400 {
        return Err(format!("HTTP {status}: {text}"));
    }

    Ok(text)
}

/// Streams an HTTP POST response back to the frontend via a Tauri IPC Channel.
/// Bypasses tauri_plugin_http's fetch interception, which may not properly
/// bridge ReadableStream for SSE responses in the webview.
#[tauri::command]
pub async fn stream_local_http(
    url: String,
    headers: HashMap<String, String>,
    body: String,
    timeout_secs: u64,
    on_chunk: Channel<HttpStreamChunk>,
) -> Result<u16, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(timeout_secs))
        .no_proxy()
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let mut req = client.post(&url);
    for (k, v) in &headers {
        req = req.header(k.as_str(), v.as_str());
    }
    req = req.body(body);

    let response = req.send().await.map_err(|e| format!("Request failed: {e}"))?;
    let status = response.status().as_u16();

    if !response.status().is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {text}"));
    }

    let mut stream = response.bytes_stream();
    while let Some(chunk_result) = stream.next().await {
        match chunk_result {
            Ok(bytes) => {
                let text = String::from_utf8_lossy(&bytes).to_string();
                if let Err(e) = on_chunk.send(HttpStreamChunk { data: text }) {
                    log::debug!("Channel closed by receiver: {e}");
                    break;
                }
            }
            Err(e) => {
                return Err(format!("Stream error: {e}"));
            }
        }
    }

    Ok(status)
}
