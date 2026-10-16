use std::path::{Path, PathBuf};

use crate::core::agent::{session::validate_session_id, workspace::default_agent_workspace};

/// Chat folders live beside the agent's default workspace rather than in a
/// data path of their own: `<data>/agent-workspace/chat/<thread id>`.
const CHAT_DIR: &str = "chat";

/// Where a run's scratch lives inside its chat folder.
pub(crate) const TMP_DIR: &str = ".tmp";
/// `PIP_TARGET` / `PYTHONPATH`: packages a chat installs stay in that chat.
pub(crate) const PACKAGES_DIR: &str = ".packages";
/// `BUN_INSTALL`: bun's cache and global installs.
pub(crate) const BUN_DIR: &str = ".bun";
/// The script files `run_script` writes before running them.
pub(crate) const SCRIPTS_DIR: &str = ".atomic";

pub(crate) struct ChatWorkdir {
    pub root: PathBuf,
}

impl ChatWorkdir {
    pub fn tmp(&self) -> PathBuf {
        self.root.join(TMP_DIR)
    }
    pub fn packages(&self) -> PathBuf {
        self.root.join(PACKAGES_DIR)
    }
    pub fn bun(&self) -> PathBuf {
        self.root.join(BUN_DIR)
    }
    pub fn scripts(&self) -> PathBuf {
        self.root.join(SCRIPTS_DIR)
    }
}

/// The folder all chat folders sit in.
pub(crate) fn chat_root(data_folder: &Path) -> PathBuf {
    default_agent_workspace(data_folder).join(CHAT_DIR)
}

pub(crate) fn chat_workdir(data_folder: &Path, thread_id: &str) -> Result<PathBuf, String> {
    validate_session_id(thread_id)
        .map_err(|_| "threadId must be a safe single path component".to_owned())?;
    Ok(chat_root(data_folder).join(thread_id))
}

pub(crate) fn ensure_chat_workdir(
    data_folder: &Path,
    thread_id: &str,
) -> Result<ChatWorkdir, String> {
    let root = chat_workdir(data_folder, thread_id)?;
    let workdir = ChatWorkdir { root };
    for dir in [
        workdir.root.clone(),
        workdir.tmp(),
        workdir.packages(),
        workdir.bun(),
        workdir.scripts(),
    ] {
        std::fs::create_dir_all(&dir)
            .map_err(|error| format!("Could not create '{}': {error}", dir.display()))?;
    }
    Ok(workdir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::agent::test_support::TestWorkspace;

    #[test]
    fn puts_each_chat_in_its_own_folder_under_the_agent_workspace() {
        let data = TestWorkspace::new();
        let workdir = ensure_chat_workdir(data.path(), "thread-1").unwrap();

        assert_eq!(
            workdir.root,
            data.path()
                .join("agent-workspace")
                .join("chat")
                .join("thread-1")
        );
        for dir in [
            workdir.tmp(),
            workdir.packages(),
            workdir.bun(),
            workdir.scripts(),
        ] {
            assert!(dir.is_dir(), "{} was not created", dir.display());
        }
    }

    #[test]
    fn refuses_a_thread_id_that_is_not_one_path_component() {
        let data = TestWorkspace::new();
        for id in ["", "..", ".", "a/b", "../escape"] {
            assert!(
                chat_workdir(data.path(), id).is_err(),
                "{id:?} was accepted"
            );
        }
        #[cfg(windows)]
        assert!(chat_workdir(data.path(), r"a\b").is_err());
    }
}
