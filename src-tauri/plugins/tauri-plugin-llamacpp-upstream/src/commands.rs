//! The one llama-server probe the app still runs itself: whether an installed binary advertises a
//! speculative-decoding type. Loading, unloading and sessions belong to `atomic-chat-core`.

use std::collections::HashMap;
use std::time::Duration;
use tokio::process::Command;

use crate::error::{ErrorCode, LlamacppError, ServerResult};
use crate::path::validate_binary_path;
use jan_utils::{
    add_cuda_paths, binary_requires_cuda, setup_library_path, setup_windows_process_flags,
};

/// Check whether the installed llama-server binary advertises a speculative type.
#[tauri::command]
pub async fn check_spec_type_support(
    backend_path: &str,
    spec_type: &str,
    envs: HashMap<String, String>,
) -> ServerResult<bool> {
    let bin_path = validate_binary_path(backend_path)?;
    let mut command = Command::new(&bin_path);
    command.arg("-h");
    command.envs(envs);
    setup_windows_process_flags(&mut command);
    let cuda_found = add_cuda_paths(&mut command);
    if !cuda_found && binary_requires_cuda(&bin_path) {
        log::warn!(
            "llama.cpp backend appears to require CUDA, but CUDA not found. Capability probe may fail."
        );
    }
    setup_library_path(bin_path.parent(), &mut command);

    let output = tokio::time::timeout(Duration::from_secs(5), command.output())
        .await
        .map_err(|_| {
            LlamacppError::new(
                ErrorCode::ModelLoadTimedOut,
                "Timed out while probing llama.cpp backend capabilities.".into(),
                Some(format!(
                    "llama-server -h did not finish within 5s for {}",
                    backend_path
                )),
            )
        })?
        .map_err(|e| {
            LlamacppError::new(
                ErrorCode::ModelLoadFailed,
                "Could not probe llama.cpp backend capabilities.".into(),
                Some(e.to_string()),
            )
        })?;

    let help = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(help.contains(spec_type))
}
