use std::{collections::HashMap, sync::Arc};

use crate::core::{downloads::models::DownloadManagerState, mcp::models::McpSettings};
use rmcp::{
    model::{CallToolRequestParam, CallToolResult, InitializeRequestParam, Tool},
    service::RunningService,
    RoleClient, ServiceError,
};
use tokio::sync::{oneshot, Mutex, Notify};

/// Server handle type for managing the proxy server lifecycle
pub type ServerHandle =
    tokio::task::JoinHandle<Result<(), Box<dyn std::error::Error + Send + Sync>>>;

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

pub enum RunningServiceEnum {
    NoInit(RunningService<RoleClient, ()>),
    WithInit(RunningService<RoleClient, InitializeRequestParam>),
}
pub type SharedMcpServers = Arc<Mutex<HashMap<String, RunningServiceEnum>>>;

#[derive(Default)]
pub struct AppState {
    pub app_token: Option<String>,
    pub mcp_servers: SharedMcpServers,
    pub download_manager: Arc<Mutex<DownloadManagerState>>,
    pub mcp_active_servers: Arc<Mutex<HashMap<String, serde_json::Value>>>,
    pub server_handle: Arc<Mutex<Option<ServerHandle>>>,
    pub tool_call_cancellations: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
    pub mcp_settings: Arc<Mutex<McpSettings>>,
    pub mcp_shutdown_in_progress: Arc<Mutex<bool>>,
    pub mcp_monitoring_tasks: Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>,
    pub background_cleanup_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    pub mcp_server_pids: Arc<Mutex<HashMap<String, u32>>>,
    /// Remote provider configurations (e.g., Anthropic, OpenAI, etc.)
    pub provider_configs: Arc<Mutex<HashMap<String, ProviderConfig>>>,
    /// Coordinator state for the Local API Server auto-increase-ctx flow.
    /// See `AutoIncreaseState` docs for the concurrency guarantees.
    pub auto_increase_ctx: Arc<AutoIncreaseState>,
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
