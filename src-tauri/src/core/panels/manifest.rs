//! Panel manifest parsing and validation.
//!
//! The runtime authority for what a `panel.json` may contain. The written
//! definition is `src-tauri/resources/panel-contract/panel.schema.json`, and
//! `docs/superpowers/specs/2026-10-03-panel-contract-v1.md` explains the
//! reasoning; this module must agree with both. `tests/panel-contract.test.mjs`
//! pins the schema side, and the fixtures under `tests/fixtures/panels/` are
//! checked against this code in the tests below, so the two cannot drift apart
//! quietly.
//!
//! Every validation failure is collected rather than returned on the first
//! problem: a panel author fixing three mistakes should see three, and the
//! panel manager shows the list instead of hiding a broken panel.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// The contract version this host implements. A manifest written against any
/// other version is refused rather than interpreted — see the spec's
/// "Changing this contract".
pub const CONTRACT_VERSION: u32 = 1;

/// Permissions every host understands. Anything outside this set has to be
/// namespaced `vendor:name`, so a panel that stays portable looks portable.
pub const CORE_PERMISSIONS: [&str; 3] = ["storage", "mcp.read", "mcp.call"];

/// Methods that need no permission at all.
pub const ALWAYS_ALLOWED: [&str; 4] = ["host.info", "panel.theme", "panel.ready", "panel.resize"];

const MAX_ID_LEN: usize = 40;
const MIN_ID_LEN: usize = 3;
const MAX_NAME_LEN: usize = 60;
const MAX_ENTRY_LEN: usize = 200;
const MAX_DESCRIPTION_LEN: usize = 300;
const MAX_AUTHOR_LEN: usize = 100;
const MAX_PERMISSIONS: usize = 16;
const MAX_MCP_SERVERS: usize = 32;
const MAX_MCP_SERVER_LEN: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelSize {
    pub w: u32,
    pub h: u32,
}

impl Default for PanelSize {
    fn default() -> Self {
        Self { w: 4, h: 6 }
    }
}

/// A validated manifest. Constructing one of these is the only way to get a
/// panel the rest of the host will talk to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PanelManifest {
    pub contract: u32,
    pub id: String,
    pub name: String,
    pub entry: String,
    pub description: String,
    pub version: String,
    pub author: String,
    pub permissions: Vec<String>,
    pub mcp_servers: Vec<String>,
    pub default_size: PanelSize,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawManifest {
    contract: Option<serde_json::Value>,
    id: Option<serde_json::Value>,
    name: Option<serde_json::Value>,
    entry: Option<serde_json::Value>,
    description: Option<serde_json::Value>,
    version: Option<serde_json::Value>,
    author: Option<serde_json::Value>,
    permissions: Option<serde_json::Value>,
    #[serde(rename = "mcpServers")]
    mcp_servers: Option<serde_json::Value>,
    #[serde(rename = "defaultSize")]
    default_size: Option<serde_json::Value>,
}

fn id_is_valid(id: &str) -> bool {
    let bytes = id.as_bytes();
    if id.len() < MIN_ID_LEN || id.len() > MAX_ID_LEN {
        return false;
    }
    let ok_char = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-';
    let edge = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    bytes.iter().all(|b| ok_char(*b)) && edge(bytes[0]) && edge(bytes[bytes.len() - 1])
}

/// `entry` has to stay inside the panel folder. We refuse anything suspicious
/// outright instead of normalising it: at a security boundary a refusal that
/// gets logged beats silently rewriting what the author asked for.
fn entry_is_valid(entry: &str) -> bool {
    if entry.is_empty() || entry.len() > MAX_ENTRY_LEN {
        return false;
    }
    if !entry.ends_with(".html") {
        return false;
    }
    if entry.starts_with('/') || entry.starts_with('\\') {
        return false;
    }
    if entry.contains("..") {
        return false;
    }
    !entry
        .chars()
        .any(|c| matches!(c, '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control())
}

fn version_is_valid(version: &str) -> bool {
    let core = version
        .split_once(['-', '+'])
        .map(|(head, _)| head)
        .unwrap_or(version);
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
}

fn permission_is_valid(permission: &str) -> bool {
    if CORE_PERMISSIONS.contains(&permission) {
        return true;
    }
    // vendor:name — a host that does not know the vendor refuses the panel
    // rather than dropping the capability and leaving it half working.
    let Some((vendor, name)) = permission.split_once(':') else {
        return false;
    };
    let vendor_ok = !vendor.is_empty()
        && vendor.starts_with(|c: char| c.is_ascii_lowercase())
        && vendor
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    let name_ok = !name.is_empty()
        && name.starts_with(|c: char| c.is_ascii_lowercase())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-');
    vendor_ok && name_ok
}

fn string_field(
    value: Option<serde_json::Value>,
    field: &str,
    required: bool,
    max_len: usize,
    issues: &mut Vec<String>,
) -> String {
    match value {
        None | Some(serde_json::Value::Null) => {
            if required {
                issues.push(format!("missing `{field}`"));
            }
            String::new()
        }
        Some(serde_json::Value::String(text)) => {
            if required && text.is_empty() {
                issues.push(format!("`{field}` must not be empty"));
            }
            if text.chars().count() > max_len {
                issues.push(format!("`{field}` must be at most {max_len} characters"));
            }
            text
        }
        Some(_) => {
            issues.push(format!("`{field}` must be a string"));
            String::new()
        }
    }
}

/// Validate a `panel.json`. `folder` is the directory name, which `id` must
/// match — a mismatch would make the panel unaddressable on its own scheme.
pub fn parse_manifest(source: &str, folder: Option<&str>) -> Result<PanelManifest, Vec<String>> {
    let raw: RawManifest = match serde_json::from_str(source) {
        Ok(raw) => raw,
        Err(error) => return Err(vec![format!("panel.json is not valid: {error}")]),
    };
    let mut issues = Vec::new();

    match raw.contract {
        Some(serde_json::Value::Number(ref number))
            if number.as_u64() == Some(CONTRACT_VERSION as u64) => {}
        None => issues.push(format!("missing `contract` (expected {CONTRACT_VERSION})")),
        Some(ref other) => issues.push(format!(
            "`contract` is {other}, but this host implements {CONTRACT_VERSION}"
        )),
    }

    let id = string_field(raw.id, "id", true, MAX_ID_LEN, &mut issues);
    if !id.is_empty() && !id_is_valid(&id) {
        issues.push(
            "`id` must be lowercase letters, digits and dashes, 3-40 characters, not starting or ending with a dash"
                .to_string(),
        );
    }
    if let (Some(folder), false) = (folder, id.is_empty()) {
        if folder != id {
            issues.push(format!("`id` ({id}) must match the folder name ({folder})"));
        }
    }

    let name = string_field(raw.name, "name", true, MAX_NAME_LEN, &mut issues);
    let entry = string_field(raw.entry, "entry", true, MAX_ENTRY_LEN, &mut issues);
    if !entry.is_empty() && !entry_is_valid(&entry) {
        issues.push("`entry` must be a relative .html path inside the panel folder".to_string());
    }

    let description = string_field(
        raw.description,
        "description",
        false,
        MAX_DESCRIPTION_LEN,
        &mut issues,
    );
    let author = string_field(raw.author, "author", false, MAX_AUTHOR_LEN, &mut issues);
    let version = match raw.version {
        None | Some(serde_json::Value::Null) => "0.0.0".to_string(),
        Some(serde_json::Value::String(text)) => {
            if version_is_valid(&text) {
                text
            } else {
                issues.push("`version` must look like 1.2.3".to_string());
                text
            }
        }
        Some(_) => {
            issues.push("`version` must be a string".to_string());
            String::new()
        }
    };

    let mut permissions: Vec<String> = Vec::new();
    match raw.permissions {
        None | Some(serde_json::Value::Null) => {}
        Some(serde_json::Value::Array(items)) => {
            if items.len() > MAX_PERMISSIONS {
                issues.push(format!("at most {MAX_PERMISSIONS} permissions"));
            }
            let mut seen = BTreeSet::new();
            for item in items {
                match item {
                    serde_json::Value::String(text) => {
                        if !permission_is_valid(&text) {
                            issues.push(format!(
                                "unknown permission `{text}`; core permissions are {} and anything else must be namespaced vendor:name",
                                CORE_PERMISSIONS.join(", ")
                            ));
                        } else if !seen.insert(text.clone()) {
                            issues.push(format!("duplicate permission `{text}`"));
                        } else {
                            permissions.push(text);
                        }
                    }
                    _ => issues.push("each permission must be a string".to_string()),
                }
            }
        }
        Some(_) => issues.push("`permissions` must be an array".to_string()),
    }

    let mut mcp_servers: Vec<String> = Vec::new();
    let mcp_declared =
        raw.mcp_servers.is_some() && !matches!(raw.mcp_servers, Some(serde_json::Value::Null));
    match raw.mcp_servers {
        None | Some(serde_json::Value::Null) => {}
        Some(serde_json::Value::Array(items)) => {
            if items.len() > MAX_MCP_SERVERS {
                issues.push(format!("at most {MAX_MCP_SERVERS} entries in `mcpServers`"));
            }
            for item in items {
                match item {
                    serde_json::Value::String(text)
                        if !text.is_empty() && text.len() <= MAX_MCP_SERVER_LEN =>
                    {
                        mcp_servers.push(text)
                    }
                    serde_json::Value::String(_) => issues.push(format!(
                        "each `mcpServers` entry must be 1-{MAX_MCP_SERVER_LEN} characters"
                    )),
                    _ => issues.push("each `mcpServers` entry must be a string".to_string()),
                }
            }
        }
        Some(_) => issues.push("`mcpServers` must be an array".to_string()),
    }

    // Asking for MCP access without naming any server is a mistake, not a
    // grant of everything. An explicitly empty list is a deliberate nothing.
    if permissions
        .iter()
        .any(|p| p == "mcp.read" || p == "mcp.call")
        && !mcp_declared
    {
        issues.push(
            "`mcpServers` is required when `mcp.read` or `mcp.call` is requested; list the servers this panel may reach"
                .to_string(),
        );
    }

    let default_size = match raw.default_size {
        None | Some(serde_json::Value::Null) => PanelSize::default(),
        Some(value) => match serde_json::from_value::<PanelSize>(value) {
            Ok(size) if (1..=12).contains(&size.w) && (1..=24).contains(&size.h) => size,
            Ok(_) => {
                issues.push("`defaultSize` w must be 1-12 and h must be 1-24".to_string());
                PanelSize::default()
            }
            Err(error) => {
                issues.push(format!("`defaultSize` is not valid: {error}"));
                PanelSize::default()
            }
        },
    };

    if !issues.is_empty() {
        return Err(issues);
    }

    Ok(PanelManifest {
        contract: CONTRACT_VERSION,
        id,
        name,
        entry,
        description,
        version,
        author,
        permissions,
        mcp_servers,
        default_size,
    })
}

impl PanelManifest {
    /// Whether this panel declared the permission a method needs. The bridge
    /// (Phase 3) is the only caller; it exists here so the rule lives with the
    /// manifest rather than being restated next to the dispatch table.
    pub fn allows(&self, permission: &str) -> bool {
        self.permissions.iter().any(|held| held == permission)
    }

    /// Whether this panel may reach an MCP server by id.
    pub fn allows_server(&self, server: &str) -> bool {
        self.mcp_servers.iter().any(|held| held == server)
    }
}
