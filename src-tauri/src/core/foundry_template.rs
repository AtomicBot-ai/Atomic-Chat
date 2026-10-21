//! Foundry Local renders a model's own `chat_template.jinja`, but hands it the
//! request's tools (and the conversation's tool calls) already unwrapped: a
//! tool arrives as `{name, description, parameters}`, not OpenAI's
//! `{type, function: {…}}`. Templates that read `tool['function']['name']` —
//! Gemma 4's — then fail on every request that offers tools ("Trying to access
//! property 'name' on null"), and the chat gets a 502.
//!
//! Before a Foundry model loads, its template is rewritten to take either
//! shape: every `x['function']` becomes `(x['function'] if x['function'] else
//! x)`. A template that never indexes `['function']` (Qwen's prints each tool
//! with `tojson`) is left alone. The rewrite is marked so it runs once.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use once_cell::sync::Lazy;
use regex::Regex;
use tauri::{AppHandle, Runtime};

use crate::core::agent::approval_allowlist::atomic_replace;
use crate::core::agent::session::validate_session_id;
use crate::core::app::commands::get_jan_data_folder_path;

const TEMPLATE_FILE: &str = "chat_template.jinja";
const MARK: &str =
    "{#- atomic-chat: Foundry Local hands tools and tool calls over without their 'function' wrapper -#}\n";

static FUNCTION_INDEX: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\b([A-Za-z_][A-Za-z0-9_]*)\['function'\]").unwrap());
/// Gemma 4 refuses tool-call arguments that are not a mapping; Foundry Local
/// passes them as the JSON text the request carried, so they are printed as is.
static STRING_ARGUMENTS_REFUSAL: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"\{\{-?\s*raise_exception\("chat_template: tool_calls\[\]\.function\.arguments must be a JSON object[^"]*"\)\s*-?\}\}"#,
    )
    .unwrap()
});

/// The template rewritten to take unwrapped tools, or `None` when it needs no
/// change (already rewritten, or it never reads `['function']`).
pub fn repair(template: &str) -> Option<String> {
    if template.starts_with(MARK) || !FUNCTION_INDEX.is_match(template) {
        return None;
    }
    let unwrapped =
        FUNCTION_INDEX.replace_all(template, "($1['function'] if $1['function'] else $1)");
    let arguments =
        STRING_ARGUMENTS_REFUSAL.replace_all(&unwrapped, "{{- function['arguments'] | trim -}}");
    Some(format!("{MARK}{arguments}"))
}

fn template_path(data_folder: &Path, model_id: &str) -> Result<PathBuf, String> {
    validate_session_id(model_id).map_err(|_| "Invalid Foundry Local model id".to_owned())?;
    Ok(data_folder
        .join("foundry-local")
        .join("models")
        .join(model_id)
        .join(TEMPLATE_FILE))
}

/// Rewrite one model's template in place. `false`: nothing to do (no
/// template, or it already takes unwrapped tools).
pub fn repair_model(data_folder: &Path, model_id: &str) -> Result<bool, String> {
    let path = template_path(data_folder, model_id)?;
    let template = match fs::read_to_string(&path) {
        Ok(template) => template,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("Could not read the chat template: {error}")),
    };
    let Some(repaired) = repair(&template) else {
        return Ok(false);
    };
    let temporary = path.with_extension(format!("jinja.{}.tmp", uuid::Uuid::new_v4().simple()));
    let result = (|| {
        let mut file = fs::File::create(&temporary).map_err(|error| error.to_string())?;
        file.write_all(repaired.as_bytes())
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        atomic_replace(&temporary, &path).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
        .map(|()| true)
        .map_err(|error| format!("Could not update the chat template: {error}"))
}

/// Called by the Foundry Local extension right before it asks the core to
/// load a model.
#[tauri::command]
pub async fn foundry_local_repair_chat_template<R: Runtime>(
    app_handle: AppHandle<R>,
    model_id: String,
) -> Result<bool, String> {
    let data_folder = get_jan_data_folder_path(app_handle);
    tokio::task::spawn_blocking(move || repair_model(&data_folder, &model_id))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    // The lines of Gemma 4's template (Foundry Local asset, version 3) that
    // read `['function']`, plus the refusal of string arguments.
    const GEMMA4: &str = r#"{%- macro format_function_declaration(tool_data) -%}
    declaration:{{- tool_data['function']['name'] -}}{description:<|"|>{{- tool_data['function']['description'] -}}<|"|>
    {%- set params = tool_data['function']['parameters'] -%}
    {%- if 'response' in tool_data['function'] -%}
{%- endmacro -%}
                    {%- set function = tool_call['function'] -%}
                        {{- raise_exception("chat_template: tool_calls[].function.arguments must be a JSON object (mapping), not a string. Deserialize arguments before passing to the template.") -}}
                                {%- set ns_tname.name = tc['function']['name'] -%}
"#;

    #[test]
    fn every_function_index_takes_an_unwrapped_tool_too() {
        let repaired = repair(GEMMA4).unwrap();
        assert!(repaired.starts_with(MARK));
        // Every `['function']` left is inside one of the fallbacks.
        let fallback =
            Regex::new(r"\(([A-Za-z_][A-Za-z0-9_]*)\['function'\] if ([A-Za-z_][A-Za-z0-9_]*)\['function'\] else ([A-Za-z_][A-Za-z0-9_]*)\)")
                .unwrap();
        assert!(!fallback.replace_all(&repaired, "").contains("['function']"));
        assert!(repaired.contains(
            "declaration:{{- (tool_data['function'] if tool_data['function'] else tool_data)['name'] -}}"
        ));
        assert!(repaired.contains(
            "{%- set function = (tool_call['function'] if tool_call['function'] else tool_call) -%}"
        ));
        assert!(repaired.contains(
            "{%- set ns_tname.name = (tc['function'] if tc['function'] else tc)['name'] -%}"
        ));
        assert!(repaired.contains("{{- function['arguments'] | trim -}}"));
        assert!(!repaired.contains("raise_exception"));
    }

    #[test]
    fn runs_once_and_leaves_other_templates_alone() {
        let repaired = repair(GEMMA4).unwrap();
        assert_eq!(repair(&repaired), None);
        let qwen = "{%- for tool in tools %}\n{{- tool | tojson }}\n{%- endfor %}";
        assert_eq!(repair(qwen), None);
    }

    #[test]
    fn rewrites_the_models_file_in_place_once() {
        let data = tempfile::tempdir().unwrap();
        let dir = data
            .path()
            .join("foundry-local/models/gemma-4-e2b-it-cuda-gpu");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(TEMPLATE_FILE), GEMMA4).unwrap();

        assert!(repair_model(data.path(), "gemma-4-e2b-it-cuda-gpu").unwrap());
        assert!(fs::read_to_string(dir.join(TEMPLATE_FILE))
            .unwrap()
            .starts_with(MARK));
        assert!(!repair_model(data.path(), "gemma-4-e2b-it-cuda-gpu").unwrap());
        assert!(!repair_model(data.path(), "not-downloaded").unwrap());
        assert!(repair_model(data.path(), "../escape").is_err());
        assert_eq!(
            fs::read_dir(&dir).unwrap().count(),
            1,
            "no temporary file left"
        );
    }
}
