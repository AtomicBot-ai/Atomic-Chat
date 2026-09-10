//! Sign-in flows that are not "paste an API key".
//!
//! Today that is one thing: connecting a ChatGPT subscription so its models can
//! be used like any other cloud provider. See
//! `docs/decisions/2026-08-27-connect-a-chatgpt-subscription-as-a-model-provider.md`
//! for why the tokens live here in Rust and never cross IPC.

pub mod chatgpt;
pub mod commands;
pub mod state;
pub mod store;

#[cfg(test)]
mod tests;
