//! Ollama's model API, as the Runtimes panel uses it. Works the same against
//! Radium's own Ollama and one the user runs.
//!
//! Endpoints and bodies follow Ollama's `docs/api.md`: `/api/tags`,
//! `/api/ps`, streaming `POST /api/pull`, `DELETE /api/delete`, and
//! `POST /api/generate` with no prompt to load (`keep_alive: 0` unloads).

use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri_plugin_http::reqwest;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledModel {
    pub name: String,
    pub size_bytes: u64,
    pub modified_at: Option<String>,
    pub family: Option<String>,
    pub parameter_size: Option<String>,
    pub quantization: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedModel {
    pub name: String,
    pub size_bytes: u64,
    pub vram_bytes: u64,
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelList {
    pub installed: Vec<InstalledModel>,
    pub loaded: Vec<LoadedModel>,
}

/// One progress update while a model downloads.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullProgress {
    pub status: String,
    pub completed: Option<u64>,
    pub total: Option<u64>,
    pub done: bool,
}

fn client(timeout: Option<Duration>) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder().no_proxy();
    if let Some(timeout) = timeout {
        builder = builder.timeout(timeout);
    }
    builder.build().map_err(|error| error.to_string())
}

async fn error_of(response: reqwest::Response) -> String {
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    let message = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|body| body.get("error")?.as_str().map(str::to_string))
        .unwrap_or(text);
    format!("Ollama answered {status}: {message}")
}

fn u64_at(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn str_at(value: &Value, pointer: &str) -> Option<String> {
    value.pointer(pointer)?.as_str().map(str::to_string)
}

/// Model names are Ollama references such as `qwen3:8b` or
/// `hf.co/user/repo:Q4_K_M`; anything with spaces or control characters is
/// refused before it reaches the server.
pub fn check_model_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    if name.is_empty()
        || name.len() > 256
        || name.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(format!("{name:?} is not a model name"));
    }
    Ok(name)
}

pub async fn list(base_url: &str) -> Result<ModelList, String> {
    let http = client(Some(Duration::from_secs(10)))?;
    let tags = http
        .get(format!("{base_url}/api/tags"))
        .send()
        .await
        .map_err(|error| format!("Could not reach Ollama at {base_url}: {error}"))?;
    if !tags.status().is_success() {
        return Err(error_of(tags).await);
    }
    let tags: Value = tags.json().await.map_err(|error| error.to_string())?;
    let installed = tags
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|model| InstalledModel {
            name: str_at(model, "/name").unwrap_or_default(),
            size_bytes: u64_at(model, "size"),
            modified_at: str_at(model, "/modified_at"),
            family: str_at(model, "/details/family"),
            parameter_size: str_at(model, "/details/parameter_size"),
            quantization: str_at(model, "/details/quantization_level"),
        })
        .collect();

    // What is in memory is a nice-to-have; the list stands without it.
    let loaded = match http.get(format!("{base_url}/api/ps")).send().await {
        Ok(response) if response.status().is_success() => response
            .json::<Value>()
            .await
            .ok()
            .and_then(|ps| ps.get("models").and_then(Value::as_array).cloned())
            .unwrap_or_default()
            .iter()
            .map(|model| LoadedModel {
                name: str_at(model, "/name").unwrap_or_default(),
                size_bytes: u64_at(model, "size"),
                vram_bytes: u64_at(model, "size_vram"),
                expires_at: str_at(model, "/expires_at"),
            })
            .collect(),
        _ => Vec::new(),
    };
    Ok(ModelList { installed, loaded })
}

/// Parses one line of the pull stream.
pub fn parse_pull_line(line: &str) -> Result<Option<PullProgress>, String> {
    let line = line.trim();
    if line.is_empty() {
        return Ok(None);
    }
    let value: Value =
        serde_json::from_str(line).map_err(|error| format!("Unreadable progress: {error}"))?;
    if let Some(error) = value.get("error").and_then(Value::as_str) {
        return Err(error.to_string());
    }
    let status = str_at(&value, "/status").unwrap_or_default();
    Ok(Some(PullProgress {
        done: status == "success",
        completed: value.get("completed").and_then(Value::as_u64),
        total: value.get("total").and_then(Value::as_u64),
        status,
    }))
}

/// Downloads `model`, calling `on_progress` for every update, until it
/// finishes, fails or `cancel` fires.
pub async fn pull(
    base_url: &str,
    model: &str,
    cancel: CancellationToken,
    mut on_progress: impl FnMut(PullProgress),
) -> Result<(), String> {
    let model = check_model_name(model)?;
    // No overall timeout: a big model takes as long as it takes.
    let response = client(None)?
        .post(format!("{base_url}/api/pull"))
        .json(&json!({ "model": model, "stream": true }))
        .send()
        .await
        .map_err(|error| format!("Could not reach Ollama at {base_url}: {error}"))?;
    if !response.status().is_success() {
        return Err(error_of(response).await);
    }
    let mut stream = response.bytes_stream();
    let mut pending = String::new();
    let mut finished = false;
    loop {
        let chunk = tokio::select! {
            _ = cancel.cancelled() => return Err("Download cancelled".into()),
            chunk = stream.next() => chunk,
        };
        let Some(chunk) = chunk else { break };
        let chunk = chunk.map_err(|error| error.to_string())?;
        pending.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(end) = pending.find('\n') {
            let line: String = pending.drain(..=end).collect();
            if let Some(progress) = parse_pull_line(&line)? {
                finished |= progress.done;
                on_progress(progress);
            }
        }
    }
    if let Some(progress) = parse_pull_line(&pending)? {
        finished |= progress.done;
        on_progress(progress);
    }
    if finished {
        Ok(())
    } else {
        Err("The download ended before Ollama reported success".into())
    }
}

pub async fn delete(base_url: &str, model: &str) -> Result<(), String> {
    let model = check_model_name(model)?;
    let response = client(Some(Duration::from_secs(30)))?
        .delete(format!("{base_url}/api/delete"))
        .json(&json!({ "model": model }))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(error_of(response).await)
    }
}

/// Loads `model` into memory (`keep_alive` as given, or Ollama's setting),
/// or unloads it with `keep_alive = Some("0")`.
pub async fn set_loaded(base_url: &str, model: &str, keep_alive: Option<&str>) -> Result<(), String> {
    let model = check_model_name(model)?;
    let mut body = json!({ "model": model, "stream": false });
    if let Some(keep_alive) = keep_alive {
        // Ollama takes a number of seconds or a duration string.
        body["keep_alive"] = match keep_alive.parse::<i64>() {
            Ok(seconds) => json!(seconds),
            Err(_) => json!(keep_alive),
        };
    }
    // Loading a large model from disk can take minutes.
    let response = client(Some(Duration::from_secs(600)))?
        .post(format!("{base_url}/api/generate"))
        .json(&body)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(error_of(response).await)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::HashMap,
        io::{Read, Write},
        net::TcpListener,
        sync::{Arc, Mutex},
        thread,
    };

    type Seen = Arc<Mutex<Vec<(String, String, String)>>>;

    /// Answers `METHOD path` from a table and records every request body.
    fn serve(routes: &[(&str, u16, &str)]) -> (String, Seen) {
        let routes: HashMap<String, (u16, String)> = routes
            .iter()
            .map(|(key, status, body)| (key.to_string(), (*status, body.to_string())))
            .collect();
        let seen: Seen = Arc::default();
        let log = Arc::clone(&seen);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut data = Vec::new();
                let mut buffer = [0u8; 8192];
                // Read the head, then as much body as Content-Length says.
                loop {
                    let read = stream.read(&mut buffer).unwrap_or(0);
                    data.extend_from_slice(&buffer[..read]);
                    let text = String::from_utf8_lossy(&data).to_string();
                    if let Some(head_end) = text.find("\r\n\r\n") {
                        let length = text[..head_end]
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                            })
                            .unwrap_or(0);
                        if data.len() >= head_end + 4 + length || read == 0 {
                            break;
                        }
                    } else if read == 0 {
                        break;
                    }
                }
                let text = String::from_utf8_lossy(&data).to_string();
                let mut first = text.lines().next().unwrap_or("").split_whitespace();
                let method = first.next().unwrap_or("").to_string();
                let path = first.next().unwrap_or("").to_string();
                let body = text.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
                log.lock().unwrap().push((method.clone(), path.clone(), body));
                let (status, reply) = routes
                    .get(&format!("{method} {path}"))
                    .cloned()
                    .unwrap_or((404, r#"{"error":"not found"}"#.into()));
                let head = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    reply.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(reply.as_bytes());
            }
        });
        (format!("http://127.0.0.1:{port}"), seen)
    }

    #[tokio::test]
    async fn the_list_joins_installed_and_loaded_models() {
        let (base, _) = serve(&[
            (
                "GET /api/tags",
                200,
                r#"{"models":[{"name":"qwen3:8b","size":5200000000,"modified_at":"2026-09-01T10:00:00Z",
                   "details":{"family":"qwen3","parameter_size":"8.2B","quantization_level":"Q4_K_M"}},
                  {"name":"nomic-embed-text:latest","size":274000000}]}"#,
            ),
            (
                "GET /api/ps",
                200,
                r#"{"models":[{"name":"qwen3:8b","size":6000000000,"size_vram":6000000000,"expires_at":"2026-09-25T20:00:00Z"}]}"#,
            ),
        ]);
        let list = list(&base).await.unwrap();
        assert_eq!(list.installed.len(), 2);
        assert_eq!(list.installed[0].quantization.as_deref(), Some("Q4_K_M"));
        assert_eq!(list.installed[1].family, None);
        assert_eq!(list.loaded[0].vram_bytes, 6_000_000_000);
    }

    #[tokio::test]
    async fn the_list_stands_without_ps() {
        let (base, _) = serve(&[("GET /api/tags", 200, r#"{"models":[]}"#)]);
        let list = list(&base).await.unwrap();
        assert!(list.installed.is_empty() && list.loaded.is_empty());
    }

    #[tokio::test]
    async fn a_pull_reports_every_step_and_ends_on_success() {
        let stream = [
            r#"{"status":"pulling manifest"}"#,
            r#"{"status":"pulling abc123","digest":"sha256:abc123","total":2000,"completed":500}"#,
            r#"{"status":"pulling abc123","digest":"sha256:abc123","total":2000,"completed":2000}"#,
            r#"{"status":"verifying sha256 digest"}"#,
            r#"{"status":"success"}"#,
        ]
        .join("\n");
        let (base, seen) = serve(&[("POST /api/pull", 200, &stream)]);
        let mut updates = Vec::new();
        pull(&base, "qwen3:8b", CancellationToken::new(), |p| updates.push(p))
            .await
            .unwrap();
        assert_eq!(updates.len(), 5);
        assert_eq!(updates[1].completed, Some(500));
        assert_eq!(updates[1].total, Some(2000));
        assert!(updates.last().unwrap().done);
        let body: Value = serde_json::from_str(&seen.lock().unwrap()[0].2).unwrap();
        assert_eq!(body["model"], "qwen3:8b");
    }

    #[tokio::test]
    async fn a_pull_error_line_fails_with_ollamas_message() {
        let (base, _) = serve(&[(
            "POST /api/pull",
            200,
            "{\"status\":\"pulling manifest\"}\n{\"error\":\"pull model manifest: file does not exist\"}\n",
        )]);
        let error = pull(&base, "nope:latest", CancellationToken::new(), |_| {})
            .await
            .unwrap_err();
        assert!(error.contains("file does not exist"), "{error}");
    }

    #[tokio::test]
    async fn a_pull_that_never_says_success_is_not_reported_as_done() {
        let (base, _) = serve(&[("POST /api/pull", 200, "{\"status\":\"pulling manifest\"}\n")]);
        assert!(pull(&base, "qwen3:8b", CancellationToken::new(), |_| {})
            .await
            .unwrap_err()
            .contains("before Ollama reported success"));
    }

    #[tokio::test]
    async fn a_cancelled_pull_stops() {
        let (base, _) = serve(&[("POST /api/pull", 200, "{\"status\":\"pulling manifest\"}\n")]);
        let cancel = CancellationToken::new();
        cancel.cancel();
        let error = pull(&base, "qwen3:8b", cancel, |_| {}).await.unwrap_err();
        assert!(error.contains("cancelled") || error.contains("before Ollama"), "{error}");
    }

    #[tokio::test]
    async fn delete_load_and_unload_send_ollamas_bodies() {
        let (base, seen) = serve(&[
            ("DELETE /api/delete", 200, ""),
            ("POST /api/generate", 200, r#"{"done":true}"#),
        ]);
        delete(&base, "qwen3:8b").await.unwrap();
        set_loaded(&base, "qwen3:8b", None).await.unwrap();
        set_loaded(&base, "qwen3:8b", Some("0")).await.unwrap();
        set_loaded(&base, "qwen3:8b", Some("30m")).await.unwrap();
        let seen = seen.lock().unwrap();
        let body = |index: usize| serde_json::from_str::<Value>(&seen[index].2).unwrap();
        assert_eq!(seen[0].0, "DELETE");
        assert_eq!(body(0)["model"], "qwen3:8b");
        assert!(body(1).get("keep_alive").is_none());
        assert_eq!(body(2)["keep_alive"], 0);
        assert_eq!(body(3)["keep_alive"], "30m");
        assert_eq!(body(1)["stream"], false);
    }

    #[tokio::test]
    async fn an_ollama_error_is_passed_on() {
        let (base, _) = serve(&[(
            "DELETE /api/delete",
            404,
            r#"{"error":"model 'nope' not found"}"#,
        )]);
        let error = delete(&base, "nope").await.unwrap_err();
        assert!(error.contains("not found") && error.contains("404"), "{error}");
    }

    #[test]
    fn model_names_with_spaces_or_control_characters_are_refused() {
        assert!(check_model_name("qwen3:8b").is_ok());
        assert!(check_model_name("hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M").is_ok());
        assert!(check_model_name("").is_err());
        assert!(check_model_name("qwen3 8b").is_err());
        assert!(check_model_name("a\nb").is_err());
    }
}
