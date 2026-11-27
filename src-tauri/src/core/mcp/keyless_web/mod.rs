pub(crate) mod http;
pub(crate) mod web;
mod web_exa;
mod web_extract;
mod web_search;

pub(crate) use web::{fetch_keyless, search_keyless};
