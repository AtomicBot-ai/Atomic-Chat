//! Tool resource-class taxonomy (`TOOL_RESOURCE_CLASS` port).

use serde::{Deserialize, Serialize};

use super::mcp_tools::{McpBridge, MCP_TOOL_PREFIX};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceClass {
    PureRead,
    FsWrite,
    Browser,
    MemoryWrite,
    TasksWrite,
    Vision,
    ApprovalGated,
    Terminal,
    /// An MCP tool whose server advertises `readOnlyHint`. Batchable but
    /// serialized within its group: the hint comes from an external server, so
    /// it never earns `PureRead`'s parallelism.
    McpRead,
    Unknown,
}

pub fn resource_class_for(tool_name: &str) -> ResourceClass {
    match tool_name {
        "tool.view"
        | "skill.view"
        | "os.fs.read"
        | "os.fs.read_document"
        | "os.fs.list"
        | "os.fs.glob"
        | "os.fs.grep"
        | "os.fs.hash"
        | "os.fs.diff"
        | "os.fs.archive.list"
        | "os.fs.archive.read_entry"
        | "os.git.status"
        | "os.git.log"
        | "os.git.diff"
        | "os.git.show"
        | "os.git.blame"
        | "os.git.branch"
        | "os.proc.list"
        | "os.proc.read"
        | "os.code.symbols"
        | "os.code.find"
        | "os.code.refs"
        | "os.web.search"
        | "os.web.fetch"
        | "docs.list"
        | "docs.retrieve"
        | "docs.chunks"
        | "os.media.transcribe"
        | "os.media.youtube"
        | "os.clipboard.read" => ResourceClass::PureRead,
        "vision.describe" => ResourceClass::Vision,
        "os.clipboard.write" | "os.notify" => ResourceClass::MemoryWrite,
        "os.fs.write" | "os.fs.mkdir" | "os.fs.edit" => ResourceClass::FsWrite,
        "os.fs.trash"
        | "os.fs.patch"
        | "os.fs.archive.extract"
        | "os.shell.run"
        | "os.proc.kill"
        | "os.proc.spawn"
        | "os.proc.write"
        | "os.proc.stop"
        | "os.http.request"
        | "skill.run_script" => ResourceClass::ApprovalGated,
        "reply" | "finish" => ResourceClass::Terminal,
        _ => ResourceClass::Unknown,
    }
}

/// Class lookup for a concrete call, MCP-aware. `mcp.*` names resolve through
/// the turn's bridge: read-only → [`ResourceClass::McpRead`], anything else →
/// [`ResourceClass::ApprovalGated`], unresolved → fail-closed `Unknown`.
pub fn resource_class_for_call(tool_name: &str, mcp: Option<&dyn McpBridge>) -> ResourceClass {
    if tool_name.starts_with(MCP_TOOL_PREFIX) {
        return match mcp.and_then(|bridge| bridge.resolve(tool_name)) {
            Some(descriptor) if descriptor.read_only => ResourceClass::McpRead,
            Some(_) => ResourceClass::ApprovalGated,
            None => ResourceClass::Unknown,
        };
    }
    resource_class_for(tool_name)
}

pub fn is_batchable(class: ResourceClass) -> bool {
    !matches!(
        class,
        ResourceClass::ApprovalGated | ResourceClass::Terminal | ResourceClass::Unknown
    )
}

pub fn is_parallel_within_group(class: ResourceClass) -> bool {
    class == ResourceClass::PureRead
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::agent::prompt::ITERATION_ONE_TOOLS;

    #[test]
    fn classifies_every_iteration_one_tool() {
        for descriptor in ITERATION_ONE_TOOLS {
            assert_ne!(
                resource_class_for(descriptor.name),
                ResourceClass::Unknown,
                "{} lacks a resource class",
                descriptor.name
            );
        }
    }

    #[test]
    fn fails_closed_for_unknown_tools() {
        assert_eq!(resource_class_for("os.unknown"), ResourceClass::Unknown);
        assert!(!is_batchable(ResourceClass::Unknown));
    }

    #[test]
    fn only_pure_reads_parallelize_within_a_group() {
        assert!(is_batchable(ResourceClass::PureRead));
        assert!(is_parallel_within_group(ResourceClass::PureRead));
        assert!(!is_parallel_within_group(ResourceClass::FsWrite));
        assert!(is_batchable(ResourceClass::Vision));
        assert!(!is_parallel_within_group(ResourceClass::Vision));
        assert!(!is_batchable(ResourceClass::ApprovalGated));
        assert!(!is_batchable(ResourceClass::Terminal));
    }

    #[test]
    fn classifies_vision_as_a_serial_group() {
        assert_eq!(resource_class_for("vision.describe"), ResourceClass::Vision);
    }
}
