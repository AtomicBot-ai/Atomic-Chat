use std::path::{Component, Path, PathBuf};

use async_trait::async_trait;

use super::super::tools::{ApprovalHook, DesktopServices, FolderAccessHook};
use super::super::types::{ApprovalDecision, ApprovalRequest, FolderAccessRequest};

pub struct WorkspaceApproval {
    root: PathBuf,
}

impl WorkspaceApproval {
    pub fn new(root: &Path) -> Result<Self, String> {
        let root = root
            .canonicalize()
            .map_err(|error| format!("Failed to resolve eval workspace: {error}"))?;
        Ok(Self { root })
    }

    fn resource_is_allowed(&self, kind: &str, value: &str) -> bool {
        if kind != "path" && kind != "file" {
            return kind != "url" && kind != "process";
        }
        let path = Path::new(value);
        if path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
        {
            return false;
        }
        path.ancestors()
            .find_map(|ancestor| ancestor.canonicalize().ok())
            .is_some_and(|ancestor| ancestor.starts_with(&self.root))
    }
}

#[async_trait]
impl ApprovalHook for WorkspaceApproval {
    async fn is_allowed(&self, _fingerprint: &str) -> bool {
        false
    }

    async fn request(&self, request: ApprovalRequest) -> Result<ApprovalDecision, String> {
        if !request.affected_resources.is_empty()
            && request
                .affected_resources
                .iter()
                .all(|resource| self.resource_is_allowed(&resource.kind, &resource.value))
        {
            Ok(ApprovalDecision::AllowOnce)
        } else {
            Ok(ApprovalDecision::Deny)
        }
    }
}

pub struct DenyFolderAccess;

#[async_trait]
impl FolderAccessHook for DenyFolderAccess {
    async fn request(&self, _request: FolderAccessRequest) -> Result<bool, String> {
        Ok(false)
    }
}

pub struct HeadlessDesktop;

#[async_trait]
impl DesktopServices for HeadlessDesktop {
    async fn write_clipboard(&self, _text: String) -> Result<(), String> {
        Err("Clipboard is unavailable in GAIA evaluation".into())
    }

    async fn notify(&self, _title: String, _body: String) -> Result<(), String> {
        Err("Desktop notifications are unavailable in GAIA evaluation".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::agent::types::ApprovalResource;

    #[test]
    fn permits_paths_inside_workspace_and_rejects_escape() {
        let root = std::env::temp_dir().join(format!("atomic-gaia-hook-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let hook = WorkspaceApproval::new(&root).unwrap();
        assert!(hook.resource_is_allowed("path", &root.join("new.txt").to_string_lossy()));
        assert!(hook.resource_is_allowed("path", &root.join("new/deep/file.txt").to_string_lossy()));
        assert!(
            !hook.resource_is_allowed("path", &root.join("new/../../escape.txt").to_string_lossy())
        );
        assert!(!hook.resource_is_allowed("path", "/"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn denies_resource_free_and_outside_workspace_approvals() {
        let root = std::env::temp_dir().join(format!("atomic-gaia-hook-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let hook = WorkspaceApproval::new(&root).unwrap();
        let request = |affected_resources| ApprovalRequest {
            tool: "os.shell.run".into(),
            reason: "approval-gated".into(),
            preview: serde_json::json!("command"),
            affected_resources,
            fingerprint: "fingerprint".into(),
            can_remember: false,
        };

        assert!(matches!(
            hook.request(request(Vec::new())).await.unwrap(),
            ApprovalDecision::Deny
        ));
        assert!(matches!(
            hook.request(request(vec![ApprovalResource {
                kind: "path".into(),
                value: root.join("../escape.txt").display().to_string(),
                operation: "write".into(),
            }]))
            .await
            .unwrap(),
            ApprovalDecision::Deny
        ));
        std::fs::remove_dir_all(root).unwrap();
    }
}
