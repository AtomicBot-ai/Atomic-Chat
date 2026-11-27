pub mod account;
pub mod agent;
#[cfg(not(any(target_os = "ios", target_os = "android")))]
pub mod pi_agent;
pub mod app;
pub mod artifact;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod atomic_core;
pub mod auth;
pub mod chat_exec;
pub mod downloads;
#[cfg(feature = "e2e")]
pub mod e2e;
pub mod extensions;
pub mod foundry_template;
pub mod filesystem;
pub mod http;
pub mod logs;
pub mod mcp;
#[cfg(target_os = "windows")]
pub mod notifications;
pub(crate) mod process_env;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod process_reaper;
pub mod secure_env;
pub mod server;
pub mod sessions;
pub mod setup;
pub mod state;
pub mod system;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod telemetry;
pub mod threads;
pub(crate) mod tool_output;
pub mod workspace;
pub mod workspace_files;
pub(crate) mod process_tree;
pub mod skills;
#[cfg(test)]
pub(crate) mod test_support;
pub mod tray_status;
pub mod webview_store;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod updater;
