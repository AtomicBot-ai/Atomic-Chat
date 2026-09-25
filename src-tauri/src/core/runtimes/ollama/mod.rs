//! Ollama, managed from inside Radium: install Radium's pinned copy or use
//! the user's, start and stop it with Radium's settings, take over an Ollama
//! the user started, read its log, and manage its models.
//!
//! Decision: docs/decisions/2026-09-25-manage-ollama-from-radium.md

pub mod api;
pub mod commands;
pub mod install;
pub mod process;
pub mod settings;

pub use process::OllamaState;
