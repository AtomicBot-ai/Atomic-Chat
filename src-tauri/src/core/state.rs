use std::{collections::HashMap, sync::Arc};

use crate::core::{
    agent::approval_allowlist::ApprovalAllowlist, agent::pty::PtyRegistry,
    downloads::models::DownloadManagerState, mcp::models::McpSettings,
};
use rmcp::{
    model::{CallToolRequestParam, CallToolResult, InitializeRequestParam, Tool},
    service::{Peer, RunningService},
    RoleClient, ServiceError,
};
use tokio::sync::{oneshot, Mutex, Notify};

/// Handles owned by one Local API Server run.
pub struct ServerHandle {
    pub server_task: tokio::task::JoinHandle<Result<(), Box<dyn std::error::Error + Send + Sync>>>,
    pub analytics_task: tokio::task::JoinHandle<()>,
    pub analytics_shutdown: oneshot::Sender<()>,
}

/// Provider configuration for remote model providers
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct ProviderConfig {
    pub provider: String,
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub custom_headers: Vec<ProviderCustomHeader>,
    pub models: Vec<String>,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct ProviderCustomHeader {
    pub header: String,
    pub value: String,
}

/// Result of the most recent auto-increase attempt for a given model.
/// Stored so concurrent waiters can pick up the outcome without re-triggering
/// the reload. The TypeScript handler publishes it via
/// `local_backend://auto_increase_ctx_done` and the Rust proxy mirrors it here.
#[derive(Debug, Clone)]
pub struct AutoIncreaseOutcome {
    pub ok: bool,
    pub new_ctx_len: Option<i64>,
    pub reason: Option<String>,
}

/// Per-model coordinator for the Local API Server auto-increase-ctx flow.
/// The first concurrent request triggers the TS-side reload and holds the
/// `Notify`; any parallel request for the same `model_id` waits on the notify
/// and re-reads the freshly-loaded session afterwards. Without this guard we
/// would fan out N reload requests to the extension for N in-flight requests.
#[derive(Default)]
pub struct AutoIncreaseState {
    /// model_id → shared Notify for waiters.
    pub pending: Arc<Mutex<HashMap<String, Arc<Notify>>>>,
    /// model_id → last outcome, valid until a new reload begins.
    pub last_outcome: Arc<Mutex<HashMap<String, AutoIncreaseOutcome>>>,
}

pub struct PendingAgentApproval {
    pub run_id: String,
    pub fingerprint: String,
    pub can_remember: bool,
    pub sender: oneshot::Sender<crate::core::agent::types::ApprovalDecision>,
}

pub struct PendingAgentFolderAccess {
    pub run_id: String,
    pub sender: oneshot::Sender<bool>,
}

pub type AgentSessionLocks = Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>;

/// Where the running Local API Server can be reached from inside this process.
///
/// The frontend owns the configuration, so the backend only learns the
/// effective values when `start_server` runs — and the port it learns is the
/// bound one, which differs from the requested one whenever port `0` was asked
/// for (mobile). The agent needs this to route cloud models through the proxy
/// the same way the regular chat path does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalServerEndpoint {
    /// Dial address. `0.0.0.0` is a listen-any address and is stored here as
    /// its loopback equivalent.
    pub host: String,
    /// The actually-bound port.
    pub port: u16,
    /// API prefix, normalized to start with `/` (e.g. `/v1`).
    pub prefix: String,
    /// The server's own gate key, not any provider's. Empty when disabled.
    pub api_key: String,
}

impl LocalServerEndpoint {
    pub fn new(host: &str, port: u16, prefix: &str, api_key: &str) -> Self {
        let host = if host == "0.0.0.0" || host.is_empty() {
            "127.0.0.1"
        } else {
            host
        };
        let prefix = prefix.trim().trim_end_matches('/');
        let prefix = if prefix.is_empty() {
            String::new()
        } else if prefix.starts_with('/') {
            prefix.to_string()
        } else {
            format!("/{prefix}")
        };
        Self {
            host: host.to_string(),
            port,
            prefix,
            api_key: api_key.to_string(),
        }
    }

    /// Origin plus prefix, no trailing slash.
    pub fn base_url(&self) -> String {
        format!("http://{}:{}{}", self.host, self.port, self.prefix)
    }
}

pub enum RunningServiceEnum {
    NoInit(RunningService<RoleClient, ()>),
    WithInit(RunningService<RoleClient, InitializeRequestParam>),
}
pub type SharedMcpServers = Arc<Mutex<HashMap<String, RunningServiceEnum>>>;

#[derive(Default)]
pub struct AppState {
    pub app_token: Option<String>,
    pub mcp_servers: SharedMcpServers,
    pub mcp_start_generations: Arc<Mutex<HashMap<String, u64>>>,
    pub mcp_server_generations: Arc<Mutex<HashMap<String, u64>>>,
    pub mcp_server_errors: Arc<Mutex<HashMap<String, String>>>,
    pub download_manager: Arc<Mutex<DownloadManagerState>>,
    pub mcp_active_servers: Arc<Mutex<HashMap<String, serde_json::Value>>>,
    pub server_handle: Arc<Mutex<Option<ServerHandle>>>,
    /// Set while the Local API Server is running; `None` otherwise. Agent runs
    /// on cloud providers read this to reach the proxy.
    pub local_server_endpoint: Arc<Mutex<Option<LocalServerEndpoint>>>,
    pub tool_call_cancellations: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
    pub agent_pending_approvals: Arc<Mutex<HashMap<String, PendingAgentApproval>>>,
    pub agent_pending_folder_access: Arc<Mutex<HashMap<String, PendingAgentFolderAccess>>>,
    pub agent_approval_allowlist: Arc<Mutex<ApprovalAllowlist>>,
    pub agent_session_locks: AgentSessionLocks,
    /// Processes started by `os.proc.spawn`, keyed by agent session.
    ///
    /// Lives here rather than in `AgentSessionState` because that one is
    /// serialised to `agent-session.json` and cannot hold OS handles, and
    /// because these processes deliberately outlive a single turn.
    pub agent_pty_sessions: PtyRegistry,
    pub mcp_settings: Arc<Mutex<McpSettings>>,
    pub mcp_shutdown_in_progress: Arc<Mutex<bool>>,
    pub background_cleanup_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    pub mcp_server_pids: Arc<Mutex<HashMap<String, HashMap<u64, u32>>>>,
    /// Remote provider configurations (e.g., Anthropic, OpenAI, etc.)
    pub provider_configs: Arc<Mutex<HashMap<String, ProviderConfig>>>,
    /// ChatGPT subscription session. Unlike `provider_configs`, this one owns
    /// durable secrets and persists them itself — they never cross IPC.
    pub chatgpt_auth: Arc<crate::core::auth::state::ChatGptAuthState>,
    /// Coordinator state for the Local API Server auto-increase-ctx flow.
    /// See `AutoIncreaseState` docs for the concurrency guarantees.
    pub auto_increase_ctx: Arc<AutoIncreaseState>,
    /// Bounded, opt-in recorder of live proxy traffic for the API screen.
    /// Lives here rather than inside the running server so the log survives a
    /// server restart and the read commands work while the server is stopped.
    pub api_request_inspector: Arc<crate::core::server::request_inspector::RequestInspector>,
    /// Handles to the dynamic rows in the system tray menu (desktop only).
    /// Populated by `setup::setup_tray` when the tray is installed, consumed by
    /// `tray_status::update_tray_status` to re-render server / model / RAM.
    #[cfg(desktop)]
    pub tray_handles: Arc<std::sync::Mutex<Option<crate::core::tray_status::TrayHandles>>>,
}

impl RunningServiceEnum {
    pub async fn list_all_tools(&self) -> Result<Vec<Tool>, ServiceError> {
        match self {
            Self::NoInit(s) => s.list_all_tools().await,
            Self::WithInit(s) => s.list_all_tools().await,
        }
    }

    /// Cloneable client handle for this server. `Peer` is a cheap `Clone`
    /// (Arc-backed) and exposes the same request methods (`list_all_tools`,
    /// `call_tool`, …) as the owning `RunningService`. Cloning it lets callers
    /// release the `mcp_servers` map lock *before* doing slow network round
    /// trips, so one unresponsive server can't block the whole map (ATO-271).
    pub fn peer(&self) -> Peer<RoleClient> {
        match self {
            Self::NoInit(s) => s.peer().clone(),
            Self::WithInit(s) => s.peer().clone(),
        }
    }
    pub async fn call_tool(
        &self,
        params: CallToolRequestParam,
    ) -> Result<CallToolResult, ServiceError> {
        match self {
            Self::NoInit(s) => s.call_tool(params).await,
            Self::WithInit(s) => s.call_tool(params).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::LocalServerEndpoint;

    /// The backend must dial the same URL the frontend's
    /// `getLocalApiServerBaseURL` builds, including the `0.0.0.0` rewrite.
    #[test]
    fn endpoint_normalizes_listen_any_host_and_prefix() {
        assert_eq!(
            LocalServerEndpoint::new("0.0.0.0", 1337, "/v1", "").base_url(),
            "http://127.0.0.1:1337/v1"
        );
        assert_eq!(
            LocalServerEndpoint::new("127.0.0.1", 8080, "v1", "").base_url(),
            "http://127.0.0.1:8080/v1"
        );
        assert_eq!(
            LocalServerEndpoint::new("127.0.0.1", 8080, "/api/v1/", "").base_url(),
            "http://127.0.0.1:8080/api/v1"
        );
        assert_eq!(
            LocalServerEndpoint::new("127.0.0.1", 1337, "", "").base_url(),
            "http://127.0.0.1:1337"
        );
    }

    #[test]
    fn endpoint_keeps_the_server_api_key_verbatim() {
        let endpoint = LocalServerEndpoint::new("127.0.0.1", 1337, "/v1", "  s3cret  ");
        assert_eq!(endpoint.api_key, "  s3cret  ");
    }
}
