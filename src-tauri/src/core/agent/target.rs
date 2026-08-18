//! Picks the transport for an agent turn.
//!
//! Routing mirrors what `ModelFactory` already does on the regular chat path,
//! rather than inventing a third convention:
//!
//! | provider | route |
//! |---|---|
//! | `llamacpp`, `llamacpp-upstream` | direct `/completion` (GBNF, `cache_prompt`, `slot_id`) |
//! | `mlx` | direct at the session port, like `createMlxModel` |
//! | cloud | the Local API Server proxy, like `getLocalApiServerBaseURL` |
//!
//! Cloud credentials never reach this module: the proxy resolves the provider
//! from the model id and substitutes its own key and headers.

use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_llamacpp::state::LlamacppState;
use tauri_plugin_llamacpp_upstream::state::LlamacppState as LlamacppUpstreamState;

use crate::core::state::{AppState, LocalServerEndpoint};

use super::llm_client::{
    find_session_by_model_and_backend, find_session_by_model_id, LlamaBackend, LlamaSessionTarget,
};
use super::openai_client::{OpenAiTarget, OpenAiTargetKind};
use super::types::AgentTurnRequest;

/// Frontend-visible error codes, following the `AGENT_*:` convention already
/// used by `ensure_vision_requirement` so the UI can map them to locale keys.
pub const AGENT_PROVIDER_UNSUPPORTED: &str =
    "AGENT_PROVIDER_UNSUPPORTED: This provider cannot run agent turns.";
pub const AGENT_LOCAL_SERVER_REQUIRED: &str =
    "AGENT_LOCAL_SERVER_REQUIRED: Start the Local API Server to run agent turns on a cloud model.";

pub const VISION_CAPABILITY: &str = "vision";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentTarget {
    Llama(LlamaSessionTarget),
    OpenAi(OpenAiTarget),
}

impl AgentTarget {
    pub fn has_vision(&self) -> bool {
        match self {
            Self::Llama(target) => target.has_vision,
            Self::OpenAi(target) => target.has_vision,
        }
    }

    pub fn model_id(&self) -> &str {
        match self {
            Self::Llama(target) => &target.model_id,
            Self::OpenAi(target) => &target.model_id,
        }
    }
}

pub async fn resolve_agent_target<R: Runtime>(
    app_handle: &AppHandle<R>,
    state: &AppState,
    request: &AgentTurnRequest,
) -> Result<AgentTarget, String> {
    let llama_state: State<LlamacppState> = app_handle.state();
    let upstream_state: State<LlamacppUpstreamState> = app_handle.state();

    match request.provider.as_deref() {
        // A caller that predates the `provider` field gets exactly the old
        // behaviour: scan both llama.cpp plugin states.
        None => find_session_by_model_id(&request.model_id, &llama_state, &upstream_state)
            .await
            .map(AgentTarget::Llama)
            .map_err(|error| error.to_string()),
        Some("llamacpp") => find_session_by_model_and_backend(
            &request.model_id,
            LlamaBackend::Llamacpp,
            &llama_state,
            &upstream_state,
        )
        .await
        .map(AgentTarget::Llama)
        .map_err(|error| error.to_string()),
        Some("llamacpp-upstream") => find_session_by_model_and_backend(
            &request.model_id,
            LlamaBackend::LlamacppUpstream,
            &llama_state,
            &upstream_state,
        )
        .await
        .map(AgentTarget::Llama)
        .map_err(|error| error.to_string()),
        Some("mlx") => resolve_mlx_target(app_handle, request)
            .await
            .map(AgentTarget::OpenAi),
        // Apple's on-device runtime has no OpenAI-compatible endpoint to talk
        // to; failing here beats a confusing transport error later.
        Some("foundation-models") => Err(AGENT_PROVIDER_UNSUPPORTED.to_string()),
        Some(provider) => {
            let endpoint = state.local_server_endpoint.lock().await.clone();
            resolve_cloud_target(endpoint.as_ref(), provider, request).map(AgentTarget::OpenAi)
        }
    }
}

#[cfg(feature = "mlx")]
pub(crate) async fn resolve_mlx_target<R: Runtime>(
    app_handle: &AppHandle<R>,
    request: &AgentTurnRequest,
) -> Result<OpenAiTarget, String> {
    use super::llm_client::model_ids_match;
    use tauri_plugin_mlx::state::MlxState;

    let mlx_state: State<MlxState> = app_handle.state();
    let sessions = mlx_state.mlx_server_process.lock().await;
    let info = sessions
        .values()
        .map(|session| &session.info)
        .find(|info| model_ids_match(&info.model_id, &request.model_id) && !info.is_embedding)
        .ok_or_else(|| format!("no active session for model '{}'", request.model_id))?;

    Ok(OpenAiTarget {
        kind: OpenAiTargetKind::LocalMlx,
        base_url: format!("http://127.0.0.1:{}/v1", info.port),
        api_key: (!info.api_key.is_empty()).then(|| info.api_key.clone()),
        model_id: info.model_id.clone(),
        has_vision: has_vision(request),
        context_window: request.context_window,
        // mlx-vlm constrains generation with outlines/llguidance, which accepts
        // an array-root schema.
        json_schema: true,
    })
}

#[cfg(not(feature = "mlx"))]
pub(crate) async fn resolve_mlx_target<R: Runtime>(
    _app_handle: &AppHandle<R>,
    _request: &AgentTurnRequest,
) -> Result<OpenAiTarget, String> {
    Err(AGENT_PROVIDER_UNSUPPORTED.to_string())
}

/// Pure so it can be tested without a Tauri runtime.
pub(crate) fn resolve_cloud_target(
    endpoint: Option<&LocalServerEndpoint>,
    provider: &str,
    request: &AgentTurnRequest,
) -> Result<OpenAiTarget, String> {
    let endpoint = endpoint.ok_or_else(|| AGENT_LOCAL_SERVER_REQUIRED.to_string())?;
    Ok(OpenAiTarget {
        kind: OpenAiTargetKind::LocalApiServer,
        base_url: endpoint.base_url(),
        api_key: (!endpoint.api_key.is_empty()).then(|| endpoint.api_key.clone()),
        model_id: request.model_id.clone(),
        has_vision: has_vision(request),
        context_window: request.context_window,
        json_schema: supports_array_json_schema(provider),
    })
}

/// Whether a cloud provider is known to accept an **array-root**
/// `response_format` schema.
///
/// Deliberately empty. OpenAI historically requires an object root even with
/// `strict: false`, so sending the schema optimistically would burn one failed
/// request per turn on a large share of providers. Until an array-root schema
/// has been verified against a live endpoint, the prompt contract plus the
/// runner's repair step carry the shape — which is exactly how Anthropic is
/// expected to work. Add providers one at a time, each with a unit test.
fn supports_array_json_schema(_provider: &str) -> bool {
    false
}

/// Non-llama.cpp targets have no `mmproj` to inspect, so vision comes from the
/// model capabilities the frontend already tracks.
fn has_vision(request: &AgentTurnRequest) -> bool {
    request
        .capabilities
        .iter()
        .any(|capability| capability == VISION_CAPABILITY)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(model_id: &str) -> AgentTurnRequest {
        AgentTurnRequest {
            run_id: "run".into(),
            session_id: "session".into(),
            model_id: model_id.into(),
            provider: Some("openai".into()),
            capabilities: Vec::new(),
            context_window: None,
            user_message: "hi".into(),
            selected_skill: None,
            attachments: Vec::new(),
            working_dir: None,
            external_roots: Vec::new(),
            max_steps: None,
            auto_approve: false,
        }
    }

    #[test]
    fn cloud_target_points_at_the_running_local_server() {
        let endpoint = LocalServerEndpoint::new("0.0.0.0", 1337, "/v1", "s3cret");
        let target = resolve_cloud_target(Some(&endpoint), "openai", &request("gpt-4.1")).unwrap();

        assert_eq!(target.kind, OpenAiTargetKind::LocalApiServer);
        assert_eq!(target.base_url, "http://127.0.0.1:1337/v1");
        assert_eq!(target.api_key.as_deref(), Some("s3cret"));
        assert_eq!(target.model_id, "gpt-4.1");
        // The proxy resolves the provider and substitutes its key; no provider
        // credential is carried here.
        assert!(!target.json_schema);
    }

    #[test]
    fn cloud_target_honours_a_custom_port_and_prefix() {
        let endpoint = LocalServerEndpoint::new("127.0.0.1", 8080, "api/v1/", "");
        let target = resolve_cloud_target(Some(&endpoint), "groq", &request("llama-3.3")).unwrap();

        assert_eq!(target.base_url, "http://127.0.0.1:8080/api/v1");
        assert_eq!(target.api_key, None);
    }

    #[test]
    fn cloud_target_requires_a_running_local_server() {
        let error = resolve_cloud_target(None, "openai", &request("gpt-4.1")).unwrap_err();
        assert!(error.starts_with("AGENT_LOCAL_SERVER_REQUIRED:"));
    }

    #[test]
    fn vision_comes_from_the_reported_capabilities() {
        let endpoint = LocalServerEndpoint::new("127.0.0.1", 1337, "/v1", "");

        let mut text_only = request("gpt-4.1");
        text_only.capabilities = vec!["tools".into()];
        assert!(!resolve_cloud_target(Some(&endpoint), "openai", &text_only)
            .unwrap()
            .has_vision);

        let mut with_vision = request("gpt-4.1");
        with_vision.capabilities = vec!["tools".into(), "vision".into()];
        assert!(
            resolve_cloud_target(Some(&endpoint), "openai", &with_vision)
                .unwrap()
                .has_vision
        );
    }

    #[test]
    fn context_window_is_forwarded_from_the_request() {
        let endpoint = LocalServerEndpoint::new("127.0.0.1", 1337, "/v1", "");
        let mut with_window = request("gpt-4.1");
        with_window.context_window = Some(128_000);

        assert_eq!(
            resolve_cloud_target(Some(&endpoint), "openai", &with_window)
                .unwrap()
                .context_window,
            Some(128_000)
        );
    }

    /// Guard against an accidental optimistic enable: every entry must be
    /// backed by a verified live check.
    #[test]
    fn no_cloud_provider_claims_array_schema_support_yet() {
        for provider in [
            "openai",
            "anthropic",
            "google",
            "groq",
            "openrouter",
            "mistral",
        ] {
            assert!(!supports_array_json_schema(provider));
        }
    }
}
