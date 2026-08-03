use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::process::Child;
use tokio::sync::Mutex;

use crate::runtime_device::{RuntimeDeviceInfo, SharedRuntimeDevice};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub pid: i32,  // opaque handle for unload/chat
    pub port: i32, // llama-server output port
    pub model_id: String,
    pub model_path: String, // path of the loaded model
    pub is_embedding: bool,
    pub api_key: String,
    #[serde(default)]
    pub mmproj_path: Option<String>,
    /// Device the model actually runs on, parsed from the startup log. `None`
    /// when the log carried no recognisable device lines.
    #[serde(default)]
    pub runtime_device: Option<RuntimeDeviceInfo>,
}

pub struct LLamaBackendSession {
    pub child: Child,
    pub info: SessionInfo,
    /// Kept alive past readiness so `get_runtime_device` can re-snapshot: the
    /// `load_tensors` lines normally precede "listening on", but the ordering
    /// is not guaranteed on slow mmap.
    pub runtime_device: SharedRuntimeDevice,
}

/// LlamaCpp plugin state
pub struct LlamacppState {
    pub llama_server_process: Arc<Mutex<HashMap<i32, LLamaBackendSession>>>,
}

impl Default for LlamacppState {
    fn default() -> Self {
        Self {
            llama_server_process: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl LlamacppState {
    pub fn new() -> Self {
        Self::default()
    }
}
