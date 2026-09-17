//! The app as a client of `atomic-chat-core` (PLAN.md §4, stage 3a).
//!
//! The core is a separate process that owns a data folder: it holds the models
//! it loaded, and it keeps holding them when the app quits. The app finds the
//! running core — or starts one — and then talks to it over the loopback
//! control API, exactly as the CLI does. This module is the whole of that
//! client: nothing else in the app opens a socket to the core.
//!
//! Two rules shape it.
//!
//! *The webview never sees the control token.* `/atomic/v1/*` grants full
//! control over the machine's models and child processes; a token in JS would
//! be reachable from any page the webview ever renders. So the webview calls
//! the Rust command `atomic_core_call`, and Rust attaches the credential.
//!
//! *The core is not ours to kill.* We do not spawn it as a child that dies with
//! us, and quitting the app is a detach, not a shutdown — a model loaded from
//! the CLI has to survive the app closing.
//!
//! Nothing here runs unless the app's `atomic_core` flags ask for it; with them
//! off (the default) no core is started and no behaviour changes.

pub mod api_requests;
pub mod client;
pub mod cloud;
pub mod commands;
pub mod external;
pub mod launch;
#[cfg(test)]
mod live_tests;
pub mod lock;
pub mod relay;
pub mod supervisor;
#[cfg(test)]
pub(crate) mod test_support;
