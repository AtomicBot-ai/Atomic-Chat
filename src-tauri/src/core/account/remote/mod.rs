//! Remote access through the account: this computer shares its models with
//! the account's other devices (host), and uses the models of the account's
//! other computers (client). Contract: `atomic-chat-backend` README, "Remote
//! access API". Everything that opens a host — keys, addresses — is made and
//! checked here; the backend only relays sealed values. Decision record:
//! docs/decisions/2026-11-12-share-and-use-models-through-the-account.md.

pub mod api;
pub mod client;
pub mod commands;
pub mod core_env;
pub mod host;
pub mod protocol;
pub mod runtime;
pub mod state;
pub mod store;

#[cfg(test)]
mod live_tests;
#[cfg(test)]
mod tests;

pub use state::RemoteState;
