pub mod api_request_analytics;
pub(crate) mod chat_to_responses_shim;
pub(crate) mod chatgpt_route;
pub mod commands;
pub(crate) mod context_expansion;
pub mod dynamic_hosts;
#[cfg(test)]
pub mod integration_tests;
pub mod proxy;
// Same cfg as the desktop `generate_handler!` block in `lib.rs`, so the module
// and the registration of its commands cannot drift apart.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod remote_access;
pub mod remote_provider_commands;
pub mod request_inspector;
pub mod responses_shim;
pub(crate) mod sse;
pub mod state_file;
#[cfg(test)]
pub mod tests;
