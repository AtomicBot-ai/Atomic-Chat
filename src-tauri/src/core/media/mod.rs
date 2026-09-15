//! Radium Media support in the Rust shell.
//!
//! Today this is only credential storage. The media platform itself lives in
//! the web app; what cannot live there is a secret, because anything the
//! webview can read is readable by anything that can run script in the webview.

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
