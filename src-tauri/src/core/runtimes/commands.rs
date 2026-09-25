//! Tauri commands for Settings > Runtimes.

use super::{
    descriptor::RuntimeDescriptor,
    probe::{scan, Detection, Endpoint},
    registry::RUNTIMES,
};

/// Every runtime in the catalog, with Radium's integration decision for it.
#[tauri::command]
pub fn runtimes_catalog() -> Vec<RuntimeDescriptor> {
    RUNTIMES.to_vec()
}

/// Finds the inference runtimes running on this computer, plus any
/// `endpoints` the user added (another machine, a non-default port). Read-only:
/// nothing is started, loaded or changed.
#[tauri::command]
pub async fn runtimes_detect(endpoints: Option<Vec<Endpoint>>) -> Result<Vec<Detection>, String> {
    scan(&endpoints.unwrap_or_default()).await
}
