use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::process::Child;
use tokio::sync::Mutex;

use jan_utils::load_cancel::LoadCancelRegistry;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub pid: i32,
    pub port: i32,
    pub model_id: String,
    pub model_path: String,
    pub is_embedding: bool,
    pub api_key: String,
}

pub struct MlxBackendSession {
    pub child: Child,
    pub info: SessionInfo,
}

/// MLX plugin state
pub struct MlxState {
    pub mlx_server_process: Arc<Mutex<HashMap<i32, MlxBackendSession>>>,
    pub load_operation: Arc<Mutex<()>>,
    /// Loads that have not reached readiness yet — including ones still
    /// queued on `load_operation` — so a cancel can reach them.
    pub load_cancels: LoadCancelRegistry,
}

impl Default for MlxState {
    fn default() -> Self {
        Self {
            mlx_server_process: Arc::new(Mutex::new(HashMap::new())),
            load_operation: Arc::new(Mutex::new(())),
            load_cancels: LoadCancelRegistry::new(),
        }
    }
}

impl MlxState {
    pub fn new() -> Self {
        Self::default()
    }
}
