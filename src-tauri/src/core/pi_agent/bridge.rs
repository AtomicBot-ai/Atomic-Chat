//! The child only sees skill paths and tool schemas. Atomic Chat retains the live
//! MCP clients, their credentials, cancellation and secure-project checks.
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::{AppHandle, Manager, Runtime};
use tokio_util::sync::CancellationToken;

use crate::core::{
    mcp::commands::{call_tool, cancel_tool_call},
    skills,
    state::AppState,
};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Connector {
    pub server: String,
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    #[serde(skip)]
    pub project_tool: Option<super::project::ProjectTool>,
}

impl Connector {
    pub fn alias(&self) -> String {
        if let Some(tool) = self.project_tool {
            return tool.name().into();
        }
        let label: String = format!("{}_{}", self.server, self.name)
            .chars()
            .take(46)
            .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' })
            .collect();
        let digest = hex::encode(Sha256::digest(
            serde_json::to_vec(&(&self.server, &self.name)).unwrap(),
        ));
        format!("mcp_{label}_{}", &digest[..12])
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Skill {
    pub name: String,
    pub path: PathBuf,
    revision: String,
}

pub fn enabled_skills(data: &Path, tools: &[Connector]) -> Result<Vec<Skill>, String> {
    let mut names = skills::available_tool_names();
    for tool in tools {
        names.insert(tool.name.clone());
        names.insert(format!("mcp.{}.{}", tool.server, tool.name));
    }
    let registry = skills::load_registry_with_tools(data, &names)?;
    Ok(registry
        .enabled()
        .map(|record| Skill {
            name: record.manifest.name.clone(),
            path: record.root.join("SKILL.md"),
            revision: format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&(&record.manifest, &record.body)).unwrap())
            ),
        })
        .collect())
}

pub fn catalog(skills: &[Skill], connectors: &[Connector]) -> Value {
    let tools: Vec<_> = connectors
        .iter()
        .map(|tool| {
            json!({
                "alias":tool.alias(),"name":tool.name,"server":tool.server,"projectTool":tool.project_tool.is_some(),
                "description":tool.description,"parameters":tool.input_schema
            })
        })
        .collect();
    json!({"skills":skills,"tools":tools})
}

pub type Dispatch = Arc<
    dyn Fn(
            Connector,
            Map<String, Value>,
            CancellationToken,
        ) -> BoxFuture<'static, Result<Value, String>>
        + Send
        + Sync,
>;

pub fn dispatcher<R: Runtime>(
    app: AppHandle<R>,
    thread: String,
    project_id: Option<String>,
) -> Dispatch {
    Arc::new(move |tool, args, cancelled| {
        let app = app.clone();
        let thread = thread.clone();
        let project_id = project_id.clone();
        Box::pin(async move {
            if let Some(tool) = tool.project_tool {
                return super::project::call(
                    app,
                    thread,
                    project_id.as_deref(),
                    tool,
                    args,
                    cancelled,
                )
                .await;
            }
            let token = uuid::Uuid::new_v4().to_string();
            let state = app.state::<AppState>();
            let call = call_tool(
                app.clone(),
                state.clone(),
                tool.name,
                Some(tool.server),
                Some(args),
                Some(token.clone()),
                Some(thread),
            );
            tokio::pin!(call);
            tokio::select! {
                biased;
                _ = cancelled.cancelled() => {
                    let _ = cancel_tool_call(state, token).await;
                    Err("Connector call cancelled".into())
                }
                result = &mut call => serde_json::to_value(result?).map_err(|e| e.to_string()),
            }
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_skill_tracks_its_connector_and_the_users_enabled_setting() {
        let data = tempfile::tempdir().unwrap();
        let dir = skills::global_skills_dir(data.path()).join("records");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"),
            "---\nname: records\ndescription: Look up records\nrequires_tools: [mcp.records.lookup]\n---\nLook up the record.").unwrap();
        let tool = Connector {
            server: "records".into(),
            name: "lookup".into(),
            description: String::new(),
            input_schema: json!({"type": "object"}),
            project_tool: None,
        };
        let connected = std::slice::from_ref(&tool);
        assert!(enabled_skills(data.path(), &[]).unwrap().is_empty());
        assert_eq!(
            enabled_skills(data.path(), connected).unwrap()[0].name,
            "records"
        );
        skills::load_registry(data.path())
            .unwrap()
            .set_enabled("records", false)
            .unwrap();
        assert!(enabled_skills(data.path(), connected).unwrap().is_empty());
    }
}
