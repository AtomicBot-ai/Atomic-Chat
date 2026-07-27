//! Autonomous agent mode (backend core, iteration 1).
//!
//! Fully isolated from the regular chat flow (the Vercel AI SDK loop is
//! untouched). This module ports the core of the TypeScript `atomic-agent`
//! runtime to Rust: the stable-prefix system prompt, a static GBNF grammar
//! for grammar-constrained tool calls, a direct HTTP client to the local
//! `llama-server`, the `prompt -> decide -> run -> observe` loop, the
//! `ToolLoopTracker` guard, the resource-class taxonomy, and the OS core
//! tools.
//!
//! Transport: the agent talks **directly** to `llama-server` on
//! `127.0.0.1:{port}` (native `/completion` with `grammar` / `cache_prompt`
//! / `slot_id`), bypassing the `:1337` proxy. Port and api key are read from
//! the `tauri-plugin-llamacpp` session map.

pub mod approval;
pub mod approval_allowlist;
pub mod attachments;
mod batch_executor;
pub mod commands;
pub mod compressor;
#[cfg(feature = "gaia-eval")]
pub mod eval;
pub mod folder_access;
pub mod grammar;
pub mod llm_client;
pub mod loop_guard;
pub mod model_profile;
pub mod path_policy;
pub mod prompt;
pub mod resource_class;
// `loop` is a reserved keyword; the run loop lives in `runner`.
pub mod runner;
pub mod session;
pub mod shell_guard;
pub mod skills;
pub mod token_budget;
pub mod tools;
pub mod types;
pub mod workspace;

#[cfg(test)]
mod model_e2e;
#[cfg(test)]
mod runner_tests;
#[cfg(test)]
pub(crate) mod test_support;

pub use types::{
    AgentApprovalDecision, AgentEvent, AgentExternalRoot, AgentFolderAccessDecision,
    AgentTurnRequest, ApprovalDecision, ApprovalRequest, ApprovalResource, ToolCallPayload,
    ToolExecution, ToolOutcome, ToolStatus,
};
