use std::collections::VecDeque;

use serde_json::Value;
use tokio::sync::Mutex;

use super::required_string;
use crate::core::agent::prompt::{ToolDescriptor, ToolTier, ITERATION_ONE_TOOLS};
use crate::core::agent::types::ToolOutcome;

pub const LOADED_TOOLS_CAP: usize = 8;
pub const LOADED_TOOLS_MAX_CHARS: usize = 8_000;

#[derive(Default)]
pub struct LoadedTools {
    names: Mutex<VecDeque<String>>,
}

impl LoadedTools {
    pub fn restore(names: &[String]) -> Self {
        let names = names
            .iter()
            .filter(|name| {
                descriptor_for(name).is_some_and(|descriptor| descriptor.tier == ToolTier::Rare)
            })
            .take(LOADED_TOOLS_CAP)
            .cloned()
            .collect();
        Self {
            names: Mutex::new(names),
        }
    }

    pub async fn view(&self, name: &str) -> ToolOutcome {
        let Some(descriptor) = descriptor_for(name) else {
            return ToolOutcome::error(format!("Unknown tool: {name}"));
        };
        if descriptor.tier == ToolTier::Frequent {
            return ToolOutcome::ok(format!(
                "Tool `{name}` already has its full schema in the stable tool catalog"
            ));
        }

        let mut names = self.names.lock().await;
        let already_loaded = names.iter().position(|loaded| loaded == name);
        if let Some(index) = already_loaded {
            names.remove(index);
        }
        names.push_back(name.to_owned());
        while names.len() > LOADED_TOOLS_CAP {
            names.pop_front();
        }
        drop(names);

        let state = if already_loaded.is_some() {
            "already loaded; refreshed LRU position"
        } else {
            "loaded"
        };
        ToolOutcome::ok(format!(
            "{state}: {} {}\n{}",
            descriptor.name, descriptor.args_schema, descriptor.summary
        ))
    }

    pub async fn snapshot(&self) -> Vec<String> {
        self.names.lock().await.iter().cloned().collect()
    }
}

pub async fn execute(args: &Value, loaded_tools: &LoadedTools) -> Result<ToolOutcome, ToolOutcome> {
    let name = required_string(args, "name").map_err(ToolOutcome::error)?;
    Ok(loaded_tools.view(&name).await)
}

pub fn descriptor_for(name: &str) -> Option<&'static ToolDescriptor> {
    ITERATION_ONE_TOOLS
        .iter()
        .find(|descriptor| descriptor.name == name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reports_unknown_and_frequent_tools_deterministically() {
        let loaded = LoadedTools::default();
        assert_eq!(
            loaded.view("missing.tool").await.status,
            crate::core::agent::types::ToolStatus::Error
        );
        assert!(loaded
            .view("os.fs.read")
            .await
            .summary
            .contains("stable tool catalog"));
        assert!(loaded.snapshot().await.is_empty());
    }

    #[tokio::test]
    async fn loads_rare_tools_and_refreshes_existing_entry() {
        let loaded = LoadedTools::default();
        assert!(loaded.view("os.fs.hash").await.summary.contains("loaded"));
        assert!(loaded
            .view("os.fs.hash")
            .await
            .summary
            .contains("already loaded"));
        assert_eq!(loaded.snapshot().await, ["os.fs.hash"]);
    }

    #[tokio::test]
    async fn restores_only_rare_tools_in_lru_order() {
        let loaded = LoadedTools::restore(&[
            "os.fs.archive.list".into(),
            "os.fs.read".into(),
            "missing.tool".into(),
            "os.fs.hash".into(),
        ]);

        assert_eq!(
            loaded.snapshot().await,
            ["os.fs.archive.list", "os.fs.hash"]
        );
        loaded.view("os.fs.archive.list").await;
        assert_eq!(
            loaded.snapshot().await,
            ["os.fs.hash", "os.fs.archive.list"]
        );
    }

    #[tokio::test]
    async fn evicts_oldest_loaded_tool_at_cap() {
        let loaded = LoadedTools::default();
        let rare = ITERATION_ONE_TOOLS
            .iter()
            .filter(|descriptor| descriptor.tier == ToolTier::Rare)
            .take(LOADED_TOOLS_CAP + 1)
            .map(|descriptor| descriptor.name)
            .collect::<Vec<_>>();
        assert!(rare.len() > LOADED_TOOLS_CAP);
        for name in &rare {
            loaded.view(name).await;
        }
        let snapshot = loaded.snapshot().await;
        assert_eq!(snapshot.len(), LOADED_TOOLS_CAP);
        assert!(!snapshot.iter().any(|name| name == rare[0]));
    }
}
