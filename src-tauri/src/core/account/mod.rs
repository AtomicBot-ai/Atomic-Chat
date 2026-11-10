//! The Atomic Chat account: sign-in to our backend (`api.atomic.chat`) with an
//! email code or Google, the device's session, and the profile and device list
//! behind it. Contract: `atomic-chat-backend` README, "Accounts API". Decision
//! record: docs/decisions/2026-11-10-sign-in-to-an-atomic-chat-account.md.
//!
//! Tokens stay in this process, in `atomic-account.json` (mode 0600) in the
//! data folder; the webview only ever sees `AccountStatus` and DTOs without
//! them. Later account features take the access token from
//! `AccountState::access_token` / `AccountState::authed`.

pub mod api;
pub mod client_info;
pub mod commands;
pub mod google;
pub mod state;
pub mod store;

#[cfg(test)]
mod tests;

pub use state::AccountState;
