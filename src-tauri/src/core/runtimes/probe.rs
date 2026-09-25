//! Finds inference runtimes that are already running on this computer.
//!
//! Many runtimes share a default port (vLLM, TensorRT-LLM, Triton and
//! llama-cpp-python all use 8000; llama.cpp, LocalAI and whisper.cpp use 8080;
//! AUTOMATIC1111 and Forge use 7860), so a port alone says little. Each open
//! port is asked a short series of questions only one runtime answers in its
//! own way (KoboldCpp's `/api/extra/version`, Ollama's `/api/version`,
//! ComfyUI's `/system_stats`, llama.cpp's `/props` ...). A match is
//! [`Confidence::Confirmed`]. A server that only answers the generic OpenAI
//! `/v1/models` is reported as [`Confidence::PortGuess`] with every runtime
//! that uses that port, never passed off as a confirmed identity.
//!
//! Detection only reads: every request is a GET, nothing is loaded, started or
//! changed, and by default only 127.0.0.1 is asked.

use std::{collections::BTreeSet, time::Duration};

use futures::future::join_all;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri_plugin_http::reqwest;

use super::{
    descriptor::{ApiSurface, Mode, RuntimeDescriptor, TelemetrySource},
    ports::MANAGED_PORT_RANGE,
    registry::{find, RUNTIMES},
    telemetry::{engine_counters, parse_prometheus, EngineCounters},
};

/// Radium's own OpenAI server. Not scanned: Radium knows it is there, and
/// Jan's default port is the same one (see the `jan` catalog note).
const RADIUM_FACADE_PORT: u16 = 1337;

/// How long a closed port may take to refuse a connection.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(250);
/// How long one question to an open port may take.
const REQUEST_TIMEOUT: Duration = Duration::from_millis(1500);

/// A server to ask, given by the user or taken from the catalog's ports.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub base_url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    /// The server answered a question only this runtime answers that way.
    Confirmed,
    /// Only a generic OpenAI server answered, on a port this runtime uses by
    /// default.
    PortGuess,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub name: String,
    pub vram_total_mib: Option<u64>,
    pub vram_free_mib: Option<u64>,
}

/// One running server Radium found.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detection {
    pub base_url: String,
    /// The catalog id, when the runtime is known: confirmed, or the only
    /// OpenAI-compatible runtime that uses this port.
    pub runtime_id: Option<&'static str>,
    pub confidence: Confidence,
    /// Other catalog ids that answer the same way or use the same port.
    pub alternatives: Vec<&'static str>,
    pub version: Option<String>,
    /// Models the server offers.
    pub models: Vec<String>,
    /// Models loaded into memory right now, when the server says.
    pub loaded_models: Vec<String>,
    /// Devices the server reports it runs on (ComfyUI does).
    pub devices: Vec<Device>,
    /// Counters from the metrics endpoint, when the runtime has one and it is on.
    pub counters: Option<EngineCounters>,
}

// --- questions ------------------------------------------------------------------

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
        // A local runtime never needs the user's HTTPS proxy.
        .no_proxy()
        .build()
        .map_err(|error| format!("Could not prepare the runtime scan: {error}"))
}

async fn get_text(client: &reqwest::Client, url: &str) -> Option<String> {
    let response = client.get(url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.text().await.ok()
}

async fn get_json(client: &reqwest::Client, url: &str) -> Option<Value> {
    serde_json::from_str(&get_text(client, url).await?).ok()
}

fn string_at(value: &Value, pointer: &str) -> Option<String> {
    value.pointer(pointer)?.as_str().map(str::to_string)
}

fn strings_from(list: Option<&Value>, key: &str) -> Vec<String> {
    list.and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get(key)?.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Model ids from an OpenAI `/v1/models` list.
fn openai_model_ids(list: &Value) -> Option<Vec<String>> {
    let data = list.get("data")?.as_array()?;
    Some(
        data.iter()
            .filter_map(|model| model.get("id")?.as_str().map(str::to_string))
            .collect(),
    )
}

fn mib(bytes: Option<&Value>) -> Option<u64> {
    bytes?.as_u64().map(|bytes| bytes / (1024 * 1024))
}

fn confirmed(base_url: &str, runtime_id: &'static str) -> Detection {
    Detection {
        base_url: base_url.to_string(),
        runtime_id: Some(runtime_id),
        confidence: Confidence::Confirmed,
        alternatives: Vec::new(),
        version: None,
        models: Vec::new(),
        loaded_models: Vec::new(),
        devices: Vec::new(),
        counters: None,
    }
}

/// Asks one server who it is. `None` when nothing there answers like an
/// inference runtime.
pub async fn identify(client: &reqwest::Client, base_url: &str) -> Option<Detection> {
    let base = base_url.trim_end_matches('/');
    let url = |path: &str| format!("{base}{path}");

    // KoboldCpp first: it also emulates the OpenAI, Ollama and AUTOMATIC1111
    // APIs, so any later question would misname it.
    if let Some(info) = get_json(client, &url("/api/extra/version")).await {
        if info.get("result").and_then(Value::as_str) == Some("KoboldCpp") {
            let mut found = confirmed(base, "koboldcpp");
            found.version = string_at(&info, "/version");
            if let Some(list) = get_json(client, &url("/v1/models")).await {
                found.models = openai_model_ids(&list).unwrap_or_default();
            }
            return Some(found);
        }
    }

    // Ollama: `/api/version` plus a `/api/tags` model list.
    if let Some(info) = get_json(client, &url("/api/version")).await {
        if let Some(version) = string_at(&info, "/version") {
            if let Some(tags) = get_json(client, &url("/api/tags")).await {
                if tags.get("models").is_some_and(Value::is_array) {
                    let mut found = confirmed(base, "ollama");
                    found.version = Some(version);
                    found.models = strings_from(tags.get("models"), "name");
                    if let Some(running) = get_json(client, &url("/api/ps")).await {
                        found.loaded_models = strings_from(running.get("models"), "name");
                    }
                    return Some(found);
                }
            }
        }
    }

    // ComfyUI: `/system_stats` with a `system` object and a `devices` list.
    if let Some(stats) = get_json(client, &url("/system_stats")).await {
        if stats.get("system").is_some_and(Value::is_object)
            && stats.get("devices").is_some_and(Value::is_array)
        {
            let mut found = confirmed(base, "comfyui");
            found.version = string_at(&stats, "/system/comfyui_version");
            found.devices = stats["devices"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|device| Device {
                    name: device
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_string(),
                    vram_total_mib: mib(device.get("vram_total")),
                    vram_free_mib: mib(device.get("vram_free")),
                })
                .collect();
            return Some(found);
        }
    }

    // InvokeAI: `/api/v1/app/version`.
    if let Some(info) = get_json(client, &url("/api/v1/app/version")).await {
        if let Some(version) = string_at(&info, "/version") {
            let mut found = confirmed(base, "invokeai");
            found.version = Some(version);
            return Some(found);
        }
    }

    // llama.cpp's server: `/props` carries its default generation settings.
    if let Some(props) = get_json(client, &url("/props")).await {
        if props.get("default_generation_settings").is_some() {
            let mut found = confirmed(base, "llama-cpp");
            found.version = string_at(&props, "/build_info");
            if let Some(path) = string_at(&props, "/model_path") {
                found.loaded_models.push(path);
            }
            if let Some(list) = get_json(client, &url("/v1/models")).await {
                found.models = openai_model_ids(&list).unwrap_or_default();
            }
            // llama-cpp-python serves the same API from the same engine.
            found.alternatives = vec!["llama-cpp-python"];
            return Some(found);
        }
    }

    // SGLang: `/get_model_info` names the model path.
    if let Some(info) = get_json(client, &url("/get_model_info")).await {
        if let Some(path) = string_at(&info, "/model_path") {
            let mut found = confirmed(base, "sglang");
            found.loaded_models.push(path.clone());
            found.models.push(path);
            return Some(found);
        }
    }

    // Text Generation Inference: `/info` names the model id and the version.
    if let Some(info) = get_json(client, &url("/info")).await {
        if let (Some(model), Some(version)) =
            (string_at(&info, "/model_id"), string_at(&info, "/version"))
        {
            let mut found = confirmed(base, "hf-tgi");
            found.version = Some(version);
            found.loaded_models.push(model.clone());
            found.models.push(model);
            return Some(found);
        }
    }

    // AUTOMATIC1111's API (started with `--api`). Forge serves the same API
    // and cannot be told apart from it this way.
    if let Some(list) = get_json(client, &url("/sdapi/v1/sd-models")).await {
        if list.is_array() {
            let mut found = confirmed(base, "automatic1111");
            found.alternatives = vec!["sd-webui-forge"];
            found.models = strings_from(Some(&list), "model_name");
            return Some(found);
        }
    }

    // vLLM and its Aphrodite fork: known by their metric namespace. vLLM
    // serves `/metrics` without a flag.
    if let Some(metrics) = get_text(client, &url("/metrics")).await {
        let runtime = if metrics.contains("\naphrodite:") || metrics.starts_with("aphrodite:") {
            Some("aphrodite")
        } else if metrics.contains("vllm:") {
            Some("vllm")
        } else {
            None
        };
        if let Some(runtime) = runtime {
            let mut found = confirmed(base, runtime);
            found.version = get_json(client, &url("/version"))
                .await
                .and_then(|info| string_at(&info, "/version"));
            if let Some(list) = get_json(client, &url("/v1/models")).await {
                found.models = openai_model_ids(&list).unwrap_or_default();
                found.loaded_models = found.models.clone();
            }
            return Some(found);
        }
    }

    // Anything else that answers `/v1/models` like OpenAI.
    let list = get_json(client, &url("/v1/models")).await?;
    let models = openai_model_ids(&list)?;
    let candidates = port_of(base).map(openai_runtimes_on).unwrap_or_default();
    Some(Detection {
        base_url: base.to_string(),
        runtime_id: (candidates.len() == 1).then(|| candidates[0]),
        confidence: Confidence::PortGuess,
        alternatives: if candidates.len() == 1 {
            Vec::new()
        } else {
            candidates
        },
        version: None,
        models,
        loaded_models: Vec::new(),
        devices: Vec::new(),
        counters: None,
    })
}

/// Adds the counters from the runtime's metrics endpoint, when the catalog
/// lists one. An endpoint that needs a flag the user did not pass simply does
/// not answer, and the detection keeps `counters: None`.
async fn add_counters(client: &reqwest::Client, detection: &mut Detection) {
    let Some(runtime) = detection.runtime_id.and_then(find) else {
        return;
    };
    for source in runtime.telemetry {
        if let TelemetrySource::Prometheus { path, prefix, .. } = source {
            let url = format!("{}{path}", detection.base_url);
            if let Some(text) = get_text(client, &url).await {
                if let Some(counters) = engine_counters(prefix, &parse_prometheus(&text)) {
                    detection.counters = Some(counters);
                    return;
                }
            }
        }
    }
}

// --- where to look ------------------------------------------------------------------

fn port_of(base_url: &str) -> Option<u16> {
    let after_scheme = base_url.split_once("://")?.1;
    let host_port = after_scheme.split('/').next()?;
    let port = host_port.rsplit_once(':')?.1;
    port.parse().ok()
}

/// Runtimes with an OpenAI-compatible API whose default port is `port`.
fn openai_runtimes_on(port: u16) -> Vec<&'static str> {
    RUNTIMES
        .iter()
        .filter(|runtime| runtime.default_port == Some(port))
        .filter(|runtime| runtime.apis.contains(&ApiSurface::OpenAiCompatible))
        .filter(|runtime| runtime.mode != Mode::OutOfScope)
        .map(|runtime| runtime.id)
        .collect()
}

fn is_scanned(runtime: &RuntimeDescriptor) -> bool {
    runtime.mode != Mode::OutOfScope
}

/// The ports a scan of this computer asks: every catalog runtime's default
/// port, except Radium's own server and the range Radium starts managed
/// runtimes on.
pub fn default_ports() -> Vec<u16> {
    let ports: BTreeSet<u16> = RUNTIMES
        .iter()
        .filter(|runtime| is_scanned(runtime))
        .filter_map(|runtime| runtime.default_port)
        .filter(|port| *port != RADIUM_FACADE_PORT && !MANAGED_PORT_RANGE.contains(port))
        .collect();
    ports.into_iter().collect()
}

/// Checks that a user-given address is an http(s) URL with a host.
pub fn normalize_base_url(input: &str) -> Result<String, String> {
    let trimmed = input.trim().trim_end_matches('/');
    let rest = trimmed
        .strip_prefix("http://")
        .or_else(|| trimmed.strip_prefix("https://"))
        .ok_or_else(|| format!("{input:?} must start with http:// or https://"))?;
    if rest.is_empty() || rest.starts_with('/') || rest.contains(char::is_whitespace) {
        return Err(format!("{input:?} has no host"));
    }
    Ok(trimmed.to_string())
}

async fn port_is_open(host: &str, port: u16) -> bool {
    matches!(
        tokio::time::timeout(CONNECT_TIMEOUT, tokio::net::TcpStream::connect((host, port))).await,
        Ok(Ok(_))
    )
}

/// Asks every default port on 127.0.0.1, plus the given endpoints, in
/// parallel. Closed ports cost one refused connection each.
pub async fn scan(extra: &[Endpoint]) -> Result<Vec<Detection>, String> {
    scan_ports("127.0.0.1", &default_ports(), extra).await
}

pub async fn scan_ports(
    host: &str,
    ports: &[u16],
    extra: &[Endpoint],
) -> Result<Vec<Detection>, String> {
    let client = client()?;
    let mut bases: Vec<String> = Vec::new();

    let open = join_all(ports.iter().map(|port| async move {
        port_is_open(host, *port).await.then_some(*port)
    }))
    .await;
    for port in open.into_iter().flatten() {
        bases.push(format!("http://{host}:{port}"));
    }
    for endpoint in extra {
        let base = normalize_base_url(&endpoint.base_url)?;
        if !bases.contains(&base) {
            bases.push(base);
        }
    }

    let found = join_all(bases.iter().map(|base| {
        let client = &client;
        async move {
            let mut detection = identify(client, base).await?;
            add_counters(client, &mut detection).await;
            Some(detection)
        }
    }))
    .await;
    Ok(found.into_iter().flatten().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::HashMap,
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    /// A tiny HTTP server answering GETs from a path -> JSON/text table. Any
    /// other path gets a 404, the way a real runtime answers an unknown route.
    fn serve(routes: &[(&str, &str)]) -> String {
        let routes: HashMap<String, String> = routes
            .iter()
            .map(|(path, body)| (path.to_string(), body.to_string()))
            .collect();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut buffer = [0u8; 4096];
                let read = stream.read(&mut buffer).unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..read]);
                let path = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("/")
                    .to_string();
                let (status, body) = match routes.get(&path) {
                    Some(body) => ("200 OK", body.clone()),
                    None => ("404 Not Found", "{\"detail\":\"Not Found\"}".to_string()),
                };
                let reply = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(reply.as_bytes());
            }
        });
        format!("http://127.0.0.1:{port}")
    }

    async fn detect(routes: &[(&str, &str)]) -> Option<Detection> {
        let base = serve(routes);
        let client = client().unwrap();
        let mut detection = identify(&client, &base).await?;
        add_counters(&client, &mut detection).await;
        Some(detection)
    }

    #[tokio::test]
    async fn ollama_is_recognised_with_its_models_and_what_is_loaded() {
        let found = detect(&[
            ("/api/version", r#"{"version":"0.12.3"}"#),
            (
                "/api/tags",
                r#"{"models":[{"name":"qwen3:8b"},{"name":"llama3.2:3b"}]}"#,
            ),
            ("/api/ps", r#"{"models":[{"name":"qwen3:8b","size_vram":5000000000}]}"#),
        ])
        .await
        .unwrap();
        assert_eq!(found.runtime_id, Some("ollama"));
        assert_eq!(found.confidence, Confidence::Confirmed);
        assert_eq!(found.version.as_deref(), Some("0.12.3"));
        assert_eq!(found.models, ["qwen3:8b", "llama3.2:3b"]);
        assert_eq!(found.loaded_models, ["qwen3:8b"]);
        assert_eq!(found.counters, None, "Ollama has no metrics endpoint");
    }

    #[tokio::test]
    async fn koboldcpp_is_not_mistaken_for_the_apis_it_emulates() {
        let found = detect(&[
            ("/api/extra/version", r#"{"result":"KoboldCpp","version":"1.99"}"#),
            // It also answers like Ollama and like OpenAI.
            ("/api/version", r#"{"version":"0.5.4"}"#),
            ("/api/tags", r#"{"models":[{"name":"koboldcpp/model"}]}"#),
            ("/v1/models", r#"{"object":"list","data":[{"id":"koboldcpp/Mistral-7B"}]}"#),
        ])
        .await
        .unwrap();
        assert_eq!(found.runtime_id, Some("koboldcpp"));
        assert_eq!(found.version.as_deref(), Some("1.99"));
        assert_eq!(found.models, ["koboldcpp/Mistral-7B"]);
    }

    #[tokio::test]
    async fn comfyui_reports_its_devices_in_mib() {
        let found = detect(&[(
            "/system_stats",
            r#"{"system":{"os":"nt","comfyui_version":"0.3.60"},
                "devices":[{"name":"cuda:0 NVIDIA GeForce RTX 3090","type":"cuda",
                            "vram_total":25769279488,"vram_free":24000000000}]}"#,
        )])
        .await
        .unwrap();
        assert_eq!(found.runtime_id, Some("comfyui"));
        assert_eq!(found.version.as_deref(), Some("0.3.60"));
        assert_eq!(found.devices.len(), 1);
        assert_eq!(found.devices[0].vram_total_mib, Some(24575));
    }

    #[tokio::test]
    async fn llama_server_is_confirmed_and_its_metrics_are_read_when_enabled() {
        let metrics = "# HELP llamacpp:prompt_tokens_total Number of prompt tokens processed.\n\
                       # TYPE llamacpp:prompt_tokens_total counter\n\
                       llamacpp:prompt_tokens_total 1200\n\
                       llamacpp:tokens_predicted_total 345\n\
                       llamacpp:requests_processing 1\n\
                       llamacpp:requests_deferred 0\n";
        let found = detect(&[
            (
                "/props",
                r#"{"default_generation_settings":{"n_ctx":8192},"model_path":"C:\\models\\qwen3-8b-q4_k_m.gguf","build_info":"b6500"}"#,
            ),
            ("/v1/models", r#"{"object":"list","data":[{"id":"qwen3-8b-q4_k_m.gguf"}]}"#),
            ("/metrics", metrics),
        ])
        .await
        .unwrap();
        assert_eq!(found.runtime_id, Some("llama-cpp"));
        assert_eq!(found.alternatives, ["llama-cpp-python"]);
        assert_eq!(found.version.as_deref(), Some("b6500"));
        assert_eq!(found.loaded_models, [r"C:\models\qwen3-8b-q4_k_m.gguf"]);
        let counters = found.counters.unwrap();
        assert_eq!(counters.prompt_tokens_total, Some(1200.0));
        assert_eq!(counters.generated_tokens_total, Some(345.0));
        assert_eq!(counters.requests_running, Some(1.0));
    }

    #[tokio::test]
    async fn llama_server_without_the_metrics_flag_still_counts_as_found() {
        let found = detect(&[("/props", r#"{"default_generation_settings":{}}"#)])
            .await
            .unwrap();
        assert_eq!(found.runtime_id, Some("llama-cpp"));
        assert_eq!(found.counters, None);
    }

    #[tokio::test]
    async fn vllm_is_known_by_its_metric_namespace() {
        let found = detect(&[
            (
                "/metrics",
                "vllm:num_requests_running{model_name=\"Qwen/Qwen3-32B-AWQ\"} 2\n\
                 vllm:num_requests_waiting{model_name=\"Qwen/Qwen3-32B-AWQ\"} 0\n\
                 vllm:prompt_tokens_total{model_name=\"Qwen/Qwen3-32B-AWQ\"} 900\n\
                 vllm:generation_tokens_total{model_name=\"Qwen/Qwen3-32B-AWQ\"} 400\n",
            ),
            ("/version", r#"{"version":"0.11.0"}"#),
            ("/v1/models", r#"{"object":"list","data":[{"id":"Qwen/Qwen3-32B-AWQ"}]}"#),
        ])
        .await
        .unwrap();
        assert_eq!(found.runtime_id, Some("vllm"));
        assert_eq!(found.version.as_deref(), Some("0.11.0"));
        assert_eq!(found.models, ["Qwen/Qwen3-32B-AWQ"]);
        assert_eq!(found.counters.unwrap().requests_running, Some(2.0));
    }

    #[tokio::test]
    async fn sglang_tgi_invokeai_and_a1111_are_each_recognised() {
        let sglang = detect(&[("/get_model_info", r#"{"model_path":"Qwen/Qwen3-8B","is_generation":true}"#)])
            .await
            .unwrap();
        assert_eq!(sglang.runtime_id, Some("sglang"));

        let tgi = detect(&[("/info", r#"{"model_id":"mistralai/Mistral-7B","version":"3.3.7"}"#)])
            .await
            .unwrap();
        assert_eq!(tgi.runtime_id, Some("hf-tgi"));
        assert_eq!(tgi.version.as_deref(), Some("3.3.7"));

        let invoke = detect(&[("/api/v1/app/version", r#"{"version":"6.8.0"}"#)])
            .await
            .unwrap();
        assert_eq!(invoke.runtime_id, Some("invokeai"));

        let a1111 = detect(&[(
            "/sdapi/v1/sd-models",
            r#"[{"title":"sdxl.safetensors","model_name":"sdxl"}]"#,
        )])
        .await
        .unwrap();
        assert_eq!(a1111.runtime_id, Some("automatic1111"));
        assert_eq!(a1111.alternatives, ["sd-webui-forge"]);
        assert_eq!(a1111.models, ["sdxl"]);
    }

    #[tokio::test]
    async fn a_generic_openai_server_is_only_a_guess_and_says_so() {
        let found = detect(&[(
            "/v1/models",
            r#"{"object":"list","data":[{"id":"some-model"}]}"#,
        )])
        .await
        .unwrap();
        // A random test port matches no catalog runtime.
        assert_eq!(found.runtime_id, None);
        assert_eq!(found.confidence, Confidence::PortGuess);
        assert_eq!(found.models, ["some-model"]);
    }

    #[tokio::test]
    async fn a_server_that_is_not_an_inference_runtime_is_not_reported() {
        assert_eq!(detect(&[("/", "<html></html>")]).await, None);
    }

    #[test]
    fn a_shared_port_lists_every_runtime_that_uses_it() {
        let on_8000 = openai_runtimes_on(8000);
        assert!(on_8000.contains(&"vllm"), "{on_8000:?}");
        assert!(on_8000.contains(&"llama-cpp-python"), "{on_8000:?}");
        assert_eq!(openai_runtimes_on(1234), ["lm-studio"]);
        assert_eq!(openai_runtimes_on(4891), ["gpt4all"]);
    }

    #[test]
    fn the_scan_skips_radiums_own_ports() {
        let ports = default_ports();
        assert!(!ports.contains(&RADIUM_FACADE_PORT));
        assert!(ports.iter().all(|port| !MANAGED_PORT_RANGE.contains(port)));
        for expected in [1234, 5001, 8080, 8188, 11434] {
            assert!(ports.contains(&expected), "missing {expected}");
        }
        let mut sorted = ports.clone();
        sorted.dedup();
        assert_eq!(sorted.len(), ports.len(), "each port asked once");
    }

    #[test]
    fn user_endpoints_must_be_http_urls_with_a_host() {
        assert_eq!(
            normalize_base_url(" http://192.168.1.20:11434/ ").unwrap(),
            "http://192.168.1.20:11434"
        );
        assert!(normalize_base_url("https://box.lan").is_ok());
        assert!(normalize_base_url("ftp://box").is_err());
        assert!(normalize_base_url("http://").is_err());
        assert!(normalize_base_url("localhost:8080").is_err());
    }

    #[test]
    fn ports_are_read_from_base_urls() {
        assert_eq!(port_of("http://127.0.0.1:8188"), Some(8188));
        assert_eq!(port_of("http://127.0.0.1:8188/api"), Some(8188));
        assert_eq!(port_of("http://example.com"), None);
    }

    #[tokio::test]
    async fn a_scan_finds_servers_on_open_ports_and_ignores_closed_ones() {
        let base = serve(&[("/props", r#"{"default_generation_settings":{}}"#)]);
        let port = port_of(&base).unwrap();
        // A port that was just freed is closed.
        let closed = {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        let found = scan_ports("127.0.0.1", &[port, closed], &[]).await.unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].runtime_id, Some("llama-cpp"));
    }

    #[tokio::test]
    async fn a_user_endpoint_is_asked_once_even_if_the_scan_also_found_it() {
        let base = serve(&[("/props", r#"{"default_generation_settings":{}}"#)]);
        let port = port_of(&base).unwrap();
        let found = scan_ports(
            "127.0.0.1",
            &[port],
            &[Endpoint {
                base_url: format!("{base}/"),
            }],
        )
        .await
        .unwrap();
        assert_eq!(found.len(), 1);
    }

    #[tokio::test]
    async fn a_bad_user_endpoint_is_an_error_not_a_silent_skip() {
        let error = scan_ports(
            "127.0.0.1",
            &[],
            &[Endpoint {
                base_url: "file:///etc/passwd".into(),
            }],
        )
        .await
        .unwrap_err();
        assert!(error.contains("http://"), "{error}");
    }
}
