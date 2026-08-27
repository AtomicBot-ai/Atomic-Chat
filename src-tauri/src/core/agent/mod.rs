//! Autonomous agent mode (backend core).
//!
//! Fully isolated from the regular chat flow (the Vercel AI SDK loop is
//! untouched). This module ports the core of the TypeScript `atomic-agent`
//! runtime to Rust: the stable-prefix system prompt, a static GBNF grammar
//! for grammar-constrained tool calls, the LLM transports, the
//! `prompt -> decide -> run -> observe` loop, the `ToolLoopTracker` guard, the
//! resource-class taxonomy, and the OS core tools.
//!
//! Transport is selected per provider by [`target::resolve_agent_target`],
//! following the same conventions as the regular chat path:
//!
//! - `llamacpp` / `llamacpp-upstream`: **directly** to `llama-server` on
//!   `127.0.0.1:{port}` (native `/completion` with `grammar` / `cache_prompt` /
//!   `slot_id`), bypassing the `:1337` proxy. Port and api key come from the
//!   `tauri-plugin-llamacpp` session map.
//! - `mlx`: **directly** to the `mlx-server` session's OpenAI-compatible
//!   `/v1/chat/completions`, so a fully local run needs no proxy.
//! - cloud providers: through the Local API Server on `:1337`, which resolves
//!   the provider by model id, substitutes its key and headers, and translates
//!   Anthropic `/messages`. No provider credential enters this module.
//!
//! Every transport implements [`llm_client::AgentLlmClient`]; the loop itself
//! never branches on which one is in use.

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
pub mod mcp_tools;
pub mod model_profile;
pub mod openai_client;
pub mod output_buffer;
pub mod path_policy;
pub mod prompt;
pub mod pty;
pub mod reply_stream;
pub mod resource_class;
// `loop` is a reserved keyword; the run loop lives in `runner`.
pub mod runner;
pub mod session;
pub mod shell_guard;
pub mod skills;
pub mod spill;
pub mod target;
pub mod token_budget;
pub mod tool_schema;
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
