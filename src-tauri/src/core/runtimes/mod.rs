//! The inference runtime layer: what Radium knows about every local inference
//! runtime, how it finds the ones already running on this computer, and the
//! shared pieces a managed runtime needs (GPU placement, ports, telemetry).
//!
//! Decision: docs/decisions/2026-09-24-integrate-inference-runtimes-behind-one-adapter-layer.md

pub mod commands;
pub mod descriptor;
pub mod gpu;
pub mod ollama;
pub mod ports;
pub mod probe;
pub mod registry;
pub mod telemetry;
