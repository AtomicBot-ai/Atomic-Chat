//! `POST /v1/images/generations` on the local API server.
//!
//! An OpenAI-shaped facade over the diffusion plugin's job runner: the same
//! validation, events, gallery write and idle timer as the Images page. Only
//! `b64_json` is served (there is no URL to hand out), and the loaded model is
//! the only model: image models are deliberately absent from `/v1/models`.

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use hyper::{Body, Response, StatusCode};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime};

use tauri_plugin_atomic_diffusion::state::{FamilyDefaults, ServerSpec};
use tauri_plugin_atomic_diffusion::{
    DiffusionErrorCode, DiffusionState, ImageGenerateRequest, SharedEmitter,
};

use super::proxy::{add_cors_headers_with_host_and_origin, model_ids_match, ProxyConfig};

/// The facade's own ceiling; the job runner's six-hour ceiling is for the
/// Images page, which shows progress.
pub(crate) const IMAGES_TIMEOUT: Duration = Duration::from_secs(30 * 60);
pub(crate) const NO_MODEL_MESSAGE: &str =
    "No image model loaded. Load an image model in Atomic Chat first.";
const MAX_N: u32 = 4;
const MIN_DIM: u32 = 256;
const MAX_DIM: u32 = 2048;
const DIM_MULTIPLE: u32 = 16;

pub(crate) struct ImagesRouteOutcome {
    pub response: Response<Body>,
    pub model_id: Option<String>,
    pub error_kind: Option<&'static str>,
}

/// The client's request, structurally validated but not yet bound to a model.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ImagesParams {
    pub model: Option<String>,
    pub prompt: String,
    pub n: u32,
    /// `None` = `auto`: the loaded family's default size.
    pub size: Option<(u32, u32)>,
    pub seed: Option<i64>,
    pub negative_prompt: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ParamError {
    pub param: &'static str,
    pub message: String,
}

fn bad(param: &'static str, message: impl Into<String>) -> ParamError {
    ParamError {
        param,
        message: message.into(),
    }
}

pub(crate) fn parse_size(size: &str) -> Result<Option<(u32, u32)>, ParamError> {
    let trimmed = size.trim();
    if trimmed.eq_ignore_ascii_case("auto") || trimmed.is_empty() {
        return Ok(None);
    }
    let (w, h) = trimmed.split_once(['x', 'X']).ok_or_else(|| {
        bad(
            "size",
            "size must be 'WIDTHxHEIGHT' (e.g. '1024x1024') or 'auto'",
        )
    })?;
    let parse = |s: &str| s.trim().parse::<u32>().ok();
    let (width, height) = match (parse(w), parse(h)) {
        (Some(w), Some(h)) => (w, h),
        _ => {
            return Err(bad(
                "size",
                "size must be 'WIDTHxHEIGHT' (e.g. '1024x1024') or 'auto'",
            ))
        }
    };
    for (label, value) in [("width", width), ("height", height)] {
        if !(MIN_DIM..=MAX_DIM).contains(&value) {
            return Err(bad(
                "size",
                format!("{label} must be between {MIN_DIM} and {MAX_DIM}"),
            ));
        }
        if value % DIM_MULTIPLE != 0 {
            return Err(bad(
                "size",
                format!("{label} must be a multiple of {DIM_MULTIPLE}"),
            ));
        }
    }
    Ok(Some((width, height)))
}

pub(crate) fn parse_params(body: &Value) -> Result<ImagesParams, ParamError> {
    let obj = body
        .as_object()
        .ok_or_else(|| bad("body", "request body must be a JSON object"))?;
    let prompt = obj
        .get("prompt")
        .and_then(|p| p.as_str())
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .ok_or_else(|| bad("prompt", "prompt is required"))?
        .to_string();
    let n = match obj.get("n") {
        None | Some(Value::Null) => 1,
        Some(v) => v
            .as_u64()
            .filter(|n| (1..=MAX_N as u64).contains(n))
            .ok_or_else(|| bad("n", format!("n must be an integer between 1 and {MAX_N}")))?
            as u32,
    };
    let size = match obj.get("size") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => parse_size(s)?,
        Some(_) => return Err(bad("size", "size must be a string")),
    };
    match obj.get("response_format") {
        None | Some(Value::Null) => {}
        Some(Value::String(f)) if f == "b64_json" => {}
        Some(Value::String(f)) => {
            let message = format!(
                "response_format '{f}' is not supported; the local server only returns 'b64_json'"
            );
            return Err(bad("response_format", message));
        }
        Some(_) => return Err(bad("response_format", "response_format must be a string")),
    }
    let seed = match obj.get("seed") {
        None | Some(Value::Null) => None,
        Some(v) => Some(
            v.as_i64()
                .ok_or_else(|| bad("seed", "seed must be an integer"))?,
        ),
    };
    let negative_prompt = match obj.get("negative_prompt") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.clone()),
        Some(Value::String(_)) => None,
        Some(_) => return Err(bad("negative_prompt", "negative_prompt must be a string")),
    };
    let model = match obj.get("model") {
        None | Some(Value::Null) => None,
        Some(Value::String(m)) if !m.trim().is_empty() => Some(m.trim().to_string()),
        Some(Value::String(_)) => None,
        Some(_) => return Err(bad("model", "model must be a string")),
    };
    Ok(ImagesParams {
        model,
        prompt,
        n,
        size,
        seed,
        negative_prompt,
    })
}

/// Bind the request to the loaded family: steps, guidance, sampler and the
/// default size come from what the plugin was told at load time.
pub(crate) fn build_request(
    params: &ImagesParams,
    defaults: &FamilyDefaults,
) -> ImageGenerateRequest {
    let (width, height) = params.size.unwrap_or((defaults.width, defaults.height));
    ImageGenerateRequest {
        prompt: params.prompt.clone(),
        negative_prompt: params.negative_prompt.clone(),
        width,
        height,
        steps: defaults.steps,
        cfg_scale: defaults.cfg_scale,
        guidance: defaults.guidance,
        seed: params.seed,
        batch_size: params.n,
        sampling_method: defaults.sampling_method.clone(),
        flow_shift: defaults.flow_shift,
        workflow: None,
        init_image_path: None,
        strength: None,
    }
}

/// Does the client's `model` name the resident model? `None` always does.
pub(crate) fn model_matches(requested: Option<&str>, spec: &ServerSpec) -> bool {
    match requested {
        None => true,
        Some(m) => model_ids_match(m, &spec.model_id) || model_ids_match(m, &spec.display_name),
    }
}

pub(crate) fn error_body(
    message: &str,
    error_type: &str,
    code: Option<&str>,
    param: Option<&str>,
) -> String {
    let mut error = serde_json::Map::new();
    error.insert("message".into(), json!(message));
    error.insert("type".into(), json!(error_type));
    error.insert(
        "param".into(),
        param.map(|p| json!(p)).unwrap_or(Value::Null),
    );
    error.insert("code".into(), code.map(|c| json!(c)).unwrap_or(Value::Null));
    json!({ "error": error }).to_string()
}

/// HTTP status, error type and `code` for a plugin error.
pub(crate) fn map_error(code: DiffusionErrorCode) -> (StatusCode, &'static str, &'static str) {
    use DiffusionErrorCode as C;
    match code {
        C::InvalidRequest | C::InvalidDimensions | C::UnsupportedWorkflow => (
            StatusCode::BAD_REQUEST,
            "invalid_request_error",
            "invalid_request",
        ),
        C::ModelNotLoaded | C::NotConfigured | C::EngineMissing => (
            StatusCode::SERVICE_UNAVAILABLE,
            "server_error",
            "model_not_loaded",
        ),
        C::JobBusy | C::QueueFull => (StatusCode::TOO_MANY_REQUESTS, "server_error", "busy"),
        C::OutOfMemory => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "server_error",
            "insufficient_memory",
        ),
        C::Cancelled => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "server_error",
            "cancelled",
        ),
        _ => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "server_error",
            "server_error",
        ),
    }
}

fn respond(
    status: StatusCode,
    body: String,
    host: &str,
    origin: &str,
    config: &ProxyConfig,
) -> Response<Body> {
    let builder = Response::builder()
        .status(status)
        .header(hyper::header::CONTENT_TYPE, "application/json");
    add_cors_headers_with_host_and_origin(builder, host, origin, &config.trusted_hosts)
        .body(Body::from(body))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

/// Cancels the job if the response future is dropped before the job ends —
/// hyper drops it when the client goes away.
struct CancelOnDrop {
    state: DiffusionState,
    emitter: SharedEmitter,
    job_id: String,
    done: bool,
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if self.done {
            return;
        }
        let state = self.state.clone();
        let emitter = self.emitter.clone();
        let job_id = self.job_id.clone();
        log::info!("[images/generations] client went away; cancelling job {job_id}");
        tokio::spawn(async move {
            let _ =
                tauri_plugin_atomic_diffusion::jobs::cancel_job(&state, emitter.as_ref(), &job_id)
                    .await;
        });
    }
}

pub(crate) async fn handle_images_generations<R: Runtime>(
    body: Body,
    host: &str,
    origin: &str,
    config: &ProxyConfig,
    app_handle: &AppHandle<R>,
) -> Result<ImagesRouteOutcome, hyper::Error> {
    let bytes = hyper::body::to_bytes(body).await?;
    let json: Value = match serde_json::from_slice(&bytes) {
        Ok(json) => json,
        Err(e) => {
            return Ok(ImagesRouteOutcome {
                response: respond(
                    StatusCode::BAD_REQUEST,
                    error_body(
                        &format!("Invalid JSON body: {e}"),
                        "invalid_request_error",
                        None,
                        None,
                    ),
                    host,
                    origin,
                    config,
                ),
                model_id: None,
                error_kind: Some("bad_request"),
            })
        }
    };
    let params = match parse_params(&json) {
        Ok(params) => params,
        Err(err) => {
            return Ok(ImagesRouteOutcome {
                response: respond(
                    StatusCode::BAD_REQUEST,
                    error_body(&err.message, "invalid_request_error", None, Some(err.param)),
                    host,
                    origin,
                    config,
                ),
                model_id: None,
                error_kind: Some("bad_request"),
            })
        }
    };

    let no_model = |model_id: Option<String>| ImagesRouteOutcome {
        response: respond(
            StatusCode::SERVICE_UNAVAILABLE,
            error_body(
                NO_MODEL_MESSAGE,
                "server_error",
                Some("model_not_loaded"),
                None,
            ),
            host,
            origin,
            config,
        ),
        model_id,
        error_kind: Some("not_found"),
    };
    let Some(state) = app_handle.try_state::<DiffusionState>() else {
        return Ok(no_model(params.model.clone()));
    };
    let state = state.inner().clone();
    let Some(spec) = state.spec() else {
        return Ok(no_model(params.model.clone()));
    };
    if !model_matches(params.model.as_deref(), &spec) {
        return Ok(no_model(params.model.clone()));
    }
    let model_id = Some(spec.model_id.clone());
    let request = build_request(&params, &spec.defaults);
    let emitter: SharedEmitter = Arc::new(app_handle.clone());

    let (job_id, handle) = match tauri_plugin_atomic_diffusion::start_image_job(
        state.clone(),
        emitter.clone(),
        request,
    ) {
        Ok(started) => started,
        Err(err) => {
            let (status, error_type, code) = map_error(err.code);
            let message = match err.details.as_deref() {
                Some(details) if status == StatusCode::BAD_REQUEST => {
                    format!("{} ({details})", err.message)
                }
                _ => err.message.clone(),
            };
            return Ok(ImagesRouteOutcome {
                response: respond(
                    status,
                    error_body(&message, error_type, Some(code), None),
                    host,
                    origin,
                    config,
                ),
                model_id,
                error_kind: Some(match status {
                    StatusCode::BAD_REQUEST => "bad_request",
                    StatusCode::TOO_MANY_REQUESTS => "busy",
                    _ => "upstream",
                }),
            });
        }
    };
    let mut guard = CancelOnDrop {
        state: state.clone(),
        emitter: emitter.clone(),
        job_id: job_id.clone(),
        done: false,
    };

    let outcome = match tokio::time::timeout(IMAGES_TIMEOUT, handle).await {
        Ok(Ok(result)) => {
            guard.done = true;
            result
        }
        Ok(Err(join)) => {
            guard.done = true;
            return Ok(ImagesRouteOutcome {
                response: respond(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    error_body(
                        &format!("The generation task failed: {join}"),
                        "server_error",
                        Some("server_error"),
                        None,
                    ),
                    host,
                    origin,
                    config,
                ),
                model_id,
                error_kind: Some("upstream"),
            });
        }
        Err(_) => {
            // The guard's Drop cancels the job.
            drop(guard);
            return Ok(ImagesRouteOutcome {
                response: respond(
                    StatusCode::GATEWAY_TIMEOUT,
                    error_body(
                        &format!(
                            "Generation did not finish within {} minutes and was cancelled.",
                            IMAGES_TIMEOUT.as_secs() / 60
                        ),
                        "server_error",
                        Some("timeout"),
                        None,
                    ),
                    host,
                    origin,
                    config,
                ),
                model_id,
                error_kind: Some("timeout"),
            });
        }
    };

    match outcome {
        Ok(outcome) => {
            let created = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let data: Vec<Value> = outcome
                .images
                .iter()
                .map(|png| json!({ "b64_json": base64::engine::general_purpose::STANDARD.encode(png) }))
                .collect();
            let paths: Vec<&str> = outcome
                .job
                .outputs
                .iter()
                .map(|o| o.path.as_str())
                .collect();
            let seed = outcome.job.outputs.first().map(|o| o.recipe.batch_seed);
            let body = json!({
                "created": created,
                "data": data,
                "atomic": {
                    "job_id": outcome.job.id,
                    "seed": seed,
                    "paths": paths,
                }
            })
            .to_string();
            Ok(ImagesRouteOutcome {
                response: respond(StatusCode::OK, body, host, origin, config),
                model_id,
                error_kind: None,
            })
        }
        Err(err) => {
            let (status, error_type, code) = map_error(err.code);
            let message = match err.details.as_deref() {
                Some(details) if !details.is_empty() => format!("{}\n{details}", err.message),
                _ => err.message.clone(),
            };
            Ok(ImagesRouteOutcome {
                response: respond(
                    status,
                    error_body(&message, error_type, Some(code), None),
                    host,
                    origin,
                    config,
                ),
                model_id,
                error_kind: Some(match status {
                    StatusCode::BAD_REQUEST => "bad_request",
                    StatusCode::TOO_MANY_REQUESTS => "busy",
                    StatusCode::SERVICE_UNAVAILABLE => "not_found",
                    _ => "upstream",
                }),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tauri_plugin_atomic_diffusion::state::{
        DiffusionBackend, EngineKind, FamilyRanges, Modality, ModelFiles, OffloadPolicy,
    };

    fn defaults() -> FamilyDefaults {
        FamilyDefaults {
            steps: 8,
            cfg_scale: 1.0,
            guidance: Some(3.5),
            sampling_method: Some("euler".into()),
            flow_shift: None,
            width: 1024,
            height: 768,
        }
    }

    fn spec() -> ServerSpec {
        ServerSpec {
            binary_dir: PathBuf::from("/opt/sd"),
            engine: EngineKind::SdCpp,
            backend: DiffusionBackend::Metal,
            backend_id: "macos-arm64".into(),
            tag: "t".into(),
            model_id: "z-image:q4_k_m".into(),
            family: "z-image".into(),
            modality: Modality::Image,
            display_name: "Z-Image Turbo".into(),
            files: ModelFiles::default(),
            defaults: defaults(),
            ranges: FamilyRanges {
                steps: (1, 50),
                dims: (256, 2048),
                dim_multiple: 16,
            },
            offload: OffloadPolicy::None,
            threads: None,
            extra_args: Vec::new(),
            startup_timeout: Duration::from_secs(1),
            cpu_fallback: false,
        }
    }

    #[test]
    fn size_parses_auto_and_dimensions_within_bounds() {
        assert_eq!(parse_size("auto").unwrap(), None);
        assert_eq!(parse_size("1024x1024").unwrap(), Some((1024, 1024)));
        assert_eq!(parse_size("512X768").unwrap(), Some((512, 768)));
        assert_eq!(parse_size("500x512").unwrap_err().param, "size");
        assert_eq!(parse_size("128x512").unwrap_err().param, "size");
        assert_eq!(parse_size("4096x512").unwrap_err().param, "size");
        assert_eq!(parse_size("large").unwrap_err().param, "size");
    }

    #[test]
    fn params_take_defaults_and_reject_url_format() {
        let params = parse_params(&json!({"prompt": " a cat "})).unwrap();
        assert_eq!(
            params,
            ImagesParams {
                model: None,
                prompt: "a cat".into(),
                n: 1,
                size: None,
                seed: None,
                negative_prompt: None,
            }
        );
        let full = parse_params(&json!({
            "model": "z-image:q4_k_m", "prompt": "x", "n": 4, "size": "512x512",
            "response_format": "b64_json", "seed": 7, "negative_prompt": "blurry"
        }))
        .unwrap();
        assert_eq!(full.n, 4);
        assert_eq!(full.size, Some((512, 512)));
        assert_eq!(full.seed, Some(7));
        assert_eq!(full.negative_prompt.as_deref(), Some("blurry"));
        assert_eq!(full.model.as_deref(), Some("z-image:q4_k_m"));

        assert_eq!(parse_params(&json!({})).unwrap_err().param, "prompt");
        assert_eq!(
            parse_params(&json!({"prompt": "x", "n": 5}))
                .unwrap_err()
                .param,
            "n"
        );
        assert_eq!(
            parse_params(&json!({"prompt": "x", "n": 0}))
                .unwrap_err()
                .param,
            "n"
        );
        let url = parse_params(&json!({"prompt": "x", "response_format": "url"})).unwrap_err();
        assert_eq!(url.param, "response_format");
        assert!(url.message.contains("b64_json"));
        assert_eq!(parse_params(&json!([1])).unwrap_err().param, "body");
    }

    #[test]
    fn request_is_bound_to_the_family_defaults() {
        let params = parse_params(&json!({"prompt": "x", "n": 2})).unwrap();
        let request = build_request(&params, &defaults());
        assert_eq!((request.width, request.height), (1024, 768));
        assert_eq!(request.steps, 8);
        assert_eq!(request.guidance, Some(3.5));
        assert_eq!(request.sampling_method.as_deref(), Some("euler"));
        assert_eq!(request.batch_size, 2);
        let sized = parse_params(&json!({"prompt": "x", "size": "512x512"})).unwrap();
        assert_eq!(build_request(&sized, &defaults()).width, 512);
    }

    #[test]
    fn model_matching_accepts_id_display_name_and_dot_underscore() {
        let s = spec();
        assert!(model_matches(None, &s));
        assert!(model_matches(Some("z-image:q4_k_m"), &s));
        assert!(model_matches(Some("Z-Image Turbo"), &s));
        assert!(model_matches(Some("z-image:q4.k.m"), &s));
        assert!(!model_matches(Some("gpt-image-1"), &s));
    }

    #[test]
    fn error_envelope_follows_the_openai_shape() {
        let body: Value = serde_json::from_str(&error_body(
            "nope",
            "invalid_request_error",
            None,
            Some("response_format"),
        ))
        .unwrap();
        assert_eq!(body["error"]["message"], "nope");
        assert_eq!(body["error"]["type"], "invalid_request_error");
        assert_eq!(body["error"]["param"], "response_format");
        assert!(body["error"]["code"].is_null());
        assert_eq!(
            map_error(DiffusionErrorCode::InvalidDimensions).0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            map_error(DiffusionErrorCode::ModelNotLoaded).0,
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(
            map_error(DiffusionErrorCode::JobBusy).0,
            StatusCode::TOO_MANY_REQUESTS
        );
        assert_eq!(
            map_error(DiffusionErrorCode::OutOfMemory).2,
            "insufficient_memory"
        );
    }

    #[tokio::test]
    async fn without_the_plugin_or_a_model_the_route_answers_503() {
        let app = tauri::test::mock_app();
        let config = ProxyConfig {
            prefix: "/v1".into(),
            proxy_api_key: String::new(),
            trusted_hosts: vec![vec!["*".into()]],
            host: "127.0.0.1".into(),
            port: 1337,
        };
        let body = Body::from(r#"{"prompt":"a cat","size":"512x512"}"#);
        let outcome = handle_images_generations(body, "127.0.0.1:1337", "", &config, app.handle())
            .await
            .unwrap();
        assert_eq!(outcome.response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let bytes = hyper::body::to_bytes(outcome.response.into_body())
            .await
            .unwrap();
        let json: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["error"]["message"], NO_MODEL_MESSAGE);
        assert_eq!(json["error"]["type"], "server_error");

        // The format check runs before the model check: a `url` request is a
        // 400 even with nothing loaded.
        let body = Body::from(r#"{"prompt":"a cat","response_format":"url"}"#);
        let outcome = handle_images_generations(body, "127.0.0.1:1337", "", &config, app.handle())
            .await
            .unwrap();
        assert_eq!(outcome.response.status(), StatusCode::BAD_REQUEST);
        let bytes = hyper::body::to_bytes(outcome.response.into_body())
            .await
            .unwrap();
        let json: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(json["error"]["type"], "invalid_request_error");
        assert_eq!(json["error"]["param"], "response_format");

        let body = Body::from("not json");
        let outcome = handle_images_generations(body, "127.0.0.1:1337", "", &config, app.handle())
            .await
            .unwrap();
        assert_eq!(outcome.response.status(), StatusCode::BAD_REQUEST);
    }
}
