use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::core::filesystem::atomic_write::atomic_replace;
use crate::core::system::opencode_family::{output_cap, PROVIDER_ID};

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    pub thread_id: String,
    pub cwd: PathBuf,
    pub session_file: Option<PathBuf>,
    pub base_url: String,
    pub api_key: Option<String>,
    pub model: String,
    pub context_window: u32,
    #[serde(default)]
    pub vision: bool,
    #[serde(default)]
    pub reasoning: bool,
    #[serde(default)]
    pub local_model: bool,
    pub thinking_level: Option<String>,
    #[serde(default)]
    pub thinking_level_map: std::collections::BTreeMap<String, Option<String>>,
    #[serde(default)]
    pub reasoning_fields: std::collections::BTreeMap<String, Value>,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub assistant_instructions: Option<String>,
    #[serde(default)]
    pub sampling: std::collections::BTreeMap<String, f64>,
    #[serde(skip)]
    pub project_id: Option<String>,
    #[serde(skip)]
    pub secure_project: bool,
    #[serde(default)]
    pub connectors: Vec<super::bridge::Connector>,
    #[serde(skip)]
    pub skills: Vec<super::bridge::Skill>,
}

pub fn profile_dir(data: &Path, thread: &str) -> Result<PathBuf, String> {
    if thread.is_empty()
        || thread.len() > 128
        || !thread
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("Invalid Agent thread identifier".into());
    }
    Ok(data.join("pi-agent").join(format!("thread-{thread}")))
}

fn models(request: &StartRequest) -> Result<Value, String> {
    let url = url::Url::parse(&request.base_url).map_err(|_| "Invalid Agent endpoint")?;
    if !matches!(url.scheme(), "http" | "https")
        || !matches!(url.host_str(), Some("127.0.0.1" | "[::1]" | "localhost"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Agent requires the app's loopback endpoint".into());
    }
    if request.context_window < 32768 || request.model.trim().is_empty() {
        return Err("Agent requires a served model with at least 32768 context tokens".into());
    }
    let mut model = json!({
        "id": request.model, "reasoning": request.reasoning,
        "contextWindow": request.context_window, "maxTokens": output_cap(request.context_window),
        "input": if request.vision { vec!["text","image"] } else { vec!["text"] }
    });
    if !request.thinking_level_map.is_empty() {
        model["thinkingLevelMap"] = json!(request.thinking_level_map);
    }
    if request.provider == "strata" {
        model["compat"] = json!({"supportsDeveloperRole": false, "maxTokensField": "max_tokens"});
    } else if request.local_model {
        model["compat"] = json!({"supportsDeveloperRole": false, "maxTokensField": "max_tokens",
            "supportsUsageInStreaming": true, "thinkingFormat":"chat-template",
            "chatTemplateKwargs":{"enable_thinking":{"$var":"thinking.enabled"}}});
    }
    // Atomic supplies the served provider's native effort fields through the extension.
    if !request.reasoning_fields.is_empty() {
        model["compat"]["supportsReasoningEffort"] = json!(false);
    }
    Ok(
        json!({"providers":{(PROVIDER_ID):{"api":"openai-completions","baseUrl":url.as_str().trim_end_matches('/'),
        "apiKey":"$ATOMIC_PI_API_KEY","models":[model]}}}),
    )
}

pub const EXTENSION: &str = include_str!("extension/atomic-approval.ts");

pub fn write_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = std::fs::write(&tmp, bytes).and_then(|()| atomic_replace(&tmp, path));
    if result.is_err() {
        let _ = std::fs::remove_file(tmp);
    }
    result.map_err(|e| e.to_string())
}

pub fn prepare(dir: &Path, request: &StartRequest, shell: &str) -> Result<Option<PathBuf>, String> {
    let config = models(request)?;
    let sessions = dir.join("sessions");
    std::fs::create_dir_all(&sessions).map_err(|e| e.to_string())?;
    let resume = match &request.session_file {
        None => None,
        Some(file) => {
            let root = sessions.canonicalize().map_err(|e| e.to_string())?;
            if file.extension().and_then(|ext| ext.to_str()) != Some("jsonl")
                || file.parent().and_then(|p| p.canonicalize().ok()).as_ref() != Some(&root)
            {
                return Err("Saved pi session belongs to another thread".into());
            }
            match std::fs::symlink_metadata(file) {
                // pi first flushes the session when the assistant replies. A process may
                // have exited before that point, leaving an unused path in thread metadata.
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Ok(meta) if meta.is_file() => Some(file.canonicalize().map_err(|e| e.to_string())?),
                _ => return Err("Saved pi session is unavailable".into()),
            }
        }
    };
    let mut tools = vec![
        "read".to_string(),
        shell.to_string(),
        "edit".to_string(),
        "write".to_string(),
    ];
    if request.secure_project {
        tools.clear();
    }
    tools.extend(
        request
            .connectors
            .iter()
            .map(super::bridge::Connector::alias),
    );
    let settings = json!({"defaultProvider":PROVIDER_ID,"defaultModel":request.model,
        "defaultTools":tools,"defaultProjectTrust":"never"});
    let mut catalog = super::bridge::catalog(&request.skills, &request.connectors);
    catalog["assistantInstructions"] = json!(request.assistant_instructions);
    if request.local_model {
        let sampling: serde_json::Map<_, _> = request
            .sampling
            .iter()
            .filter(|(key, _)| {
                matches!(
                    key.as_str(),
                    "temperature"
                        | "top_p"
                        | "top_k"
                        | "min_p"
                        | "frequency_penalty"
                        | "presence_penalty"
                        | "repeat_penalty"
                )
            })
            .map(|(key, value)| (key.clone(), json!(value)))
            .collect();
        catalog["sampling"] = Value::Object(sampling);
    }
    catalog["reasoningFields"] = json!(request.reasoning_fields);
    catalog["secureProject"] = json!(request.secure_project);
    write_file(
        &dir.join("integrations.json"),
        &serde_json::to_vec(&catalog).map_err(|e| e.to_string())?,
    )?;
    write_file(&dir.join("models.json"), config.to_string().as_bytes())?;
    write_file(&dir.join("settings.json"), settings.to_string().as_bytes())?;
    write_file(&dir.join("atomic-approval.ts"), EXTENSION.as_bytes())?;
    Ok(resume)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> StartRequest {
        serde_json::from_value(json!({"threadId":"a","cwd":".","baseUrl":"http://127.0.0.1:1337/v1",
            "apiKey":"fixture","model":"tiny","contextWindow":32768,"vision":true,"localModel":true})).unwrap()
    }
    #[test]
    fn model_profile_keeps_credentials_in_the_environment() {
        let value = models(&request()).unwrap();
        let provider = &value["providers"]["atomic"];
        assert_eq!(provider["apiKey"], "$ATOMIC_PI_API_KEY");
        assert!(!value.to_string().contains("fixture"));
        assert_eq!(provider["models"][0]["input"], json!(["text", "image"]));
        assert_eq!(provider["models"][0]["maxTokens"], 8192);
        let mut invalid = request();
        invalid.base_url = "https://example.com/v1".into();
        assert!(models(&invalid).is_err());
    }
    #[test]
    fn profile_keeps_the_model_effort_scale_and_provider_fields() {
        let dir = tempfile::tempdir().unwrap();
        let mut request = request();
        request.reasoning = true;
        request.thinking_level_map = [
            ("max".into(), Some("high".into())),
            ("minimal".into(), None),
        ]
        .into();
        request.reasoning_fields =
            [("medium".into(), json!({"reasoning_budget_tokens": 1024}))].into();
        prepare(dir.path(), &request, "bash").unwrap();
        let read = |name| {
            serde_json::from_slice::<Value>(&std::fs::read(dir.path().join(name)).unwrap()).unwrap()
        };
        assert_eq!(
            read("models.json")["providers"]["atomic"]["models"][0]["thinkingLevelMap"],
            json!({"max":"high","minimal":null})
        );
        assert_eq!(
            read("integrations.json")["reasoningFields"]["medium"]["reasoning_budget_tokens"],
            1024
        );
    }
    #[test]
    fn an_unflushed_session_may_restart_only_inside_its_own_profile() {
        let scratch = tempfile::tempdir().unwrap();
        let dir = profile_dir(scratch.path(), "first").unwrap();
        let mut request = request();
        prepare(&dir, &request, "bash").unwrap();
        request.session_file = Some(dir.join("sessions/unflushed.jsonl"));
        assert_eq!(prepare(&dir, &request, "bash").unwrap(), None);
        request.session_file = Some(scratch.path().join("unflushed.jsonl"));
        assert!(prepare(&dir, &request, "bash").is_err());
    }

    #[test]
    fn secure_tasks_offer_only_host_tools_and_the_project_assistant() {
        let scratch = tempfile::tempdir().unwrap();
        let mut request = request();
        request.secure_project = true;
        request.connectors = super::super::project::tools(true);
        request.assistant_instructions = Some("Review project files".into());
        prepare(scratch.path(), &request, "bash").unwrap();
        let read = |name: &str| {
            serde_json::from_slice::<Value>(&std::fs::read(scratch.path().join(name)).unwrap())
                .unwrap()
        };
        assert_eq!(
            read("settings.json")["defaultTools"],
            json!([
                "atomic_project_list_files",
                "atomic_project_read_file",
                "atomic_project_run_command"
            ])
        );
        let integrations = read("integrations.json");
        assert_eq!(integrations["secureProject"], true);
        assert_eq!(
            integrations["assistantInstructions"],
            "Review project files"
        );
    }

    #[test]
    fn only_local_model_requests_receive_the_sampling_controls() {
        let scratch = tempfile::tempdir().unwrap();
        let mut request = request();
        request.sampling = [
            ("temperature".into(), 0.0),
            ("top_k".into(), 40.0),
            ("stream".into(), 0.0),
        ]
        .into();
        let catalog = |r: &StartRequest| {
            prepare(scratch.path(), r, "bash").unwrap();
            serde_json::from_slice::<Value>(
                &std::fs::read(scratch.path().join("integrations.json")).unwrap(),
            )
            .unwrap()
        };
        for provider in ["llamacpp-upstream", "mlx", "strata"] {
            request.provider = provider.into();
            assert_eq!(
                catalog(&request)["sampling"],
                json!({"temperature":0.0,"top_k":40.0})
            );
        }
        request.local_model = false;
        assert!(catalog(&request).get("sampling").is_none());
    }

    #[test]
    fn thread_profiles_are_bounded_to_the_data_folder() {
        assert!(profile_dir(Path::new("data"), "../etc").is_err());
        assert_ne!(
            profile_dir(Path::new("data"), "a").unwrap(),
            profile_dir(Path::new("data"), "b").unwrap()
        );
    }
}
