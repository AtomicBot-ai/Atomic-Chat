use std::path::{Path, PathBuf};

pub(crate) struct TestWorkspace {
    path: PathBuf,
}

impl TestWorkspace {
    pub(crate) fn new() -> Self {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("agent-test-workspaces")
            .join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&path).expect("create agent test workspace");
        Self { path }
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn write(&self, relative: &str, content: impl AsRef<[u8]>) {
        let path = self.path.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create fixture parent");
        }
        std::fs::write(path, content).expect("write fixture");
    }

    pub(crate) fn read(&self, relative: &str) -> Vec<u8> {
        std::fs::read(self.path.join(relative)).expect("read fixture")
    }
}

impl Drop for TestWorkspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}
