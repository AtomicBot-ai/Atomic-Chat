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
    /// `agent.delegate`: runs a whole specialist turn that may read, write and
    /// request approvals of its own. Needs no approval itself, but must run
    /// solo — other class groups in a batch execute concurrently with it.
    Delegation,
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
        | "os.clipboard.read"
        | "net.system_map"
        | "net.connectivity"
        | "net.interfaces"
        | "net.wifi_status"
        | "net.dns_lookup"
        | "net.ping"
        | "net.traceroute"
        | "net.neighbors"
        | "net.port_check" => ResourceClass::PureRead,
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
        | "skill.run_script"
        | "net.dns_flush"
        | "net.dhcp_renew"
        | "net.adapter_restart"
        | "net.set_dns"
        | "net.wifi_reconnect"
        | "net.stack_reset" => ResourceClass::ApprovalGated,
        "agent.delegate" => ResourceClass::Delegation,
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
        ResourceClass::ApprovalGated
            | ResourceClass::Delegation
            | ResourceClass::Terminal
            | ResourceClass::Unknown
    )
}

/// Classes that must be the only call in their batch. A batch that mixes one
/// in is salvaged by keeping the first such call and dropping the rest.
pub fn runs_solo(class: ResourceClass) -> bool {
    matches!(
        class,
        ResourceClass::ApprovalGated | ResourceClass::Delegation
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
    fn network_diagnosis_reads_and_every_network_fix_asks_first() {
        for tool in crate::core::agent::tools::net::NET_DIAGNOSE_TOOLS {
            assert_eq!(resource_class_for(tool), ResourceClass::PureRead, "{tool}");
        }
        for tool in crate::core::agent::tools::net::NET_FIX_TOOLS {
            assert_eq!(
                resource_class_for(tool),
                ResourceClass::ApprovalGated,
                "{tool}"
            );
        }
    }

    #[test]
    fn delegation_runs_solo_without_being_approval_gated() {
        let class = resource_class_for("agent.delegate");
        assert_eq!(class, ResourceClass::Delegation);
        assert!(!is_batchable(class));
        assert!(runs_solo(class));
        assert!(runs_solo(ResourceClass::ApprovalGated));
        assert!(!runs_solo(ResourceClass::FsWrite));
    }

    #[test]
    fn classifies_vision_as_a_serial_group() {
        assert_eq!(resource_class_for("vision.describe"), ResourceClass::Vision);
    }
}
