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

pub mod commands;
pub mod grammar;
pub mod llm_client;
pub mod loop_guard;
pub mod prompt;
pub mod resource_class;
// `loop` is a reserved keyword; the run loop lives in `runner`.
pub mod runner;
pub mod tools;
pub mod types;

pub use types::{
    AgentEvent, AgentTurnRequest, ToolCallPayload, ToolExecution, ToolOutcome, ToolStatus,
};
