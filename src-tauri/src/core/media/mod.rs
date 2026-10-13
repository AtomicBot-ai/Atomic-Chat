//! Radium Media support in the Rust shell.
//!
//! Credential storage, the built-in engine's install and run lifecycle, and
//! the local server the Media page sends jobs to. Provider adapters and the
//! on-disk library live in the web app; only secrets and process management
//! cannot live there, because anything the webview can read is readable by
//! anything that can run script in the webview.

pub mod catalog;
pub mod engine;
pub mod secrets;
pub mod server;
pub mod supervisor;

/// Desktop only: the commands wrap the OS credential store, which mobile does
/// not have in this form and does not need - media providers are desktop.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod commands;

/// Desktop only: installs and runs the built-in engine for the Media page.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod runtime;
