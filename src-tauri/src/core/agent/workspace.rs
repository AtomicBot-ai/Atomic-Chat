use std::path::{Path, PathBuf};

pub const DEFAULT_AGENT_WORKSPACE_DIR: &str = "agent-workspace";

pub fn default_agent_workspace(data_folder: &Path) -> PathBuf {
    data_folder.join(DEFAULT_AGENT_WORKSPACE_DIR)
}

pub fn ensure_default_agent_workspace(data_folder: &Path) -> Result<PathBuf, String> {
    let workspace = default_agent_workspace(data_folder);
    std::fs::create_dir_all(&workspace).map_err(|error| {
        format!(
            "Failed to create default Agent workspace '{}': {error}",
            workspace.display()
        )
    })?;
    Ok(workspace)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::agent::test_support::TestWorkspace;

    #[test]
    fn creates_default_workspace_inside_data_folder() {
        let data_folder = TestWorkspace::new();
        let workspace =
            ensure_default_agent_workspace(data_folder.path()).expect("create Agent workspace");

        assert_eq!(
            workspace,
            data_folder.path().join(DEFAULT_AGENT_WORKSPACE_DIR)
        );
        assert!(workspace.is_dir());
    }

    #[test]
    fn creation_is_idempotent() {
        let data_folder = TestWorkspace::new();
        let first =
            ensure_default_agent_workspace(data_folder.path()).expect("create Agent workspace");
        let second =
            ensure_default_agent_workspace(data_folder.path()).expect("reuse Agent workspace");

        assert_eq!(first, second);
        assert!(second.is_dir());
    }
}
