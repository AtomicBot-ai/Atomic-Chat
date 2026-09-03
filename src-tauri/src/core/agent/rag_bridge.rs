//! Document-index (RAG) bridge for the agent loop.
//!
//! The `docs.*` tools query the same per-thread / per-project SQLite vector
//! collections the chat pipeline ingests into (`tauri-plugin-vector-db`).
//! Collection names are computed frontend-side and arrive verbatim in
//! `AgentTurnRequest.rag` — the TypeScript naming
//! (`extensions/vector-db-extension/src/index.ts`) stays the single source of
//! truth.
//!
//! Embeddings: the query is embedded over HTTP against an already-running
//! llama.cpp session flagged `is_embedding` (the frontend pre-warms the
//! `sentence-transformer-mini` model before agent turns that carry `rag`).
//! Rust never loads or downloads the model — when no session is running the
//! tools return a structured error instead.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use super::llm_client::model_ids_match;

pub const EMBEDDING_MODEL_ID: &str = "sentence-transformer-mini";
pub const DOCS_EMBED_TIMEOUT: Duration = Duration::from_secs(30);
/// Model-visible message when no embedding session is running. Rust never
/// loads the model; the frontend pre-warms it before agent turns.
pub const EMBEDDING_UNAVAILABLE: &str =
    "The document index is unavailable: the embedding model is not running. \
     Answer from the conversation, or tell the user the documents cannot be searched right now; \
     do not retry this tool.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocsScope {
    Thread,
    Project,
}

impl DocsScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Thread => "thread",
            Self::Project => "project",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "thread" => Some(Self::Thread),
            "project" => Some(Self::Project),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DocsAttachment {
    pub id: String,
    pub name: Option<String>,
    #[serde(rename = "type")]
    pub file_type: Option<String>,
    pub size: Option<i64>,
    pub chunk_count: i64,
    pub scope: &'static str,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DocsChunk {
    pub id: String,
    pub text: String,
    /// Cosine similarity (linear mode); `None` for chunk-range reads.
    pub score: Option<f32>,
    pub file_id: String,
    pub chunk_file_order: i64,
    pub scope: &'static str,
}

/// What the `docs.*` tools need from the index: scope enumeration, one query
/// embedding, and the three reads. A trait so `runner_tests` can script it
/// without SQLite or a live embedding server.
#[async_trait]
pub trait DocsBridge: Send + Sync {
    /// Thread first, then Project when configured — the tools' default merge
    /// order when no explicit scope is given.
    fn scopes(&self) -> &[DocsScope];
    async fn embed(
        &self,
        query: &str,
        cancellation: &CancellationToken,
    ) -> Result<Vec<f32>, String>;
    async fn list(&self, scope: DocsScope) -> Result<Vec<DocsAttachment>, String>;
    async fn retrieve(
        &self,
        scope: DocsScope,
        query_embedding: &[f32],
        top_k: usize,
        file_ids: Option<&[String]>,
    ) -> Result<Vec<DocsChunk>, String>;
    async fn chunks(
        &self,
        scope: DocsScope,
        file_id: &str,
        start_order: i64,
        end_order: i64,
    ) -> Result<Vec<DocsChunk>, String>;
}

type LlamacppSessions = Arc<Mutex<HashMap<i32, tauri_plugin_llamacpp::state::LLamaBackendSession>>>;
type UpstreamSessions =
    Arc<Mutex<HashMap<i32, tauri_plugin_llamacpp_upstream::state::LLamaBackendSession>>>;

pub struct LiveDocsBridge {
    base_dir: PathBuf,
    thread_collection: String,
    project_collection: Option<String>,
    scopes: Vec<DocsScope>,
    llamacpp_sessions: LlamacppSessions,
    upstream_sessions: UpstreamSessions,
    http: reqwest::Client,
}

impl LiveDocsBridge {
    pub fn new(
        base_dir: PathBuf,
        thread_collection: String,
        project_collection: Option<String>,
        llamacpp_sessions: LlamacppSessions,
        upstream_sessions: UpstreamSessions,
    ) -> Self {
        let mut scopes = vec![DocsScope::Thread];
        if project_collection.is_some() {
            scopes.push(DocsScope::Project);
        }
        Self {
            base_dir,
            thread_collection,
            project_collection,
            scopes,
            llamacpp_sessions,
            upstream_sessions,
            http: reqwest::Client::new(),
        }
    }

    fn collection_for(&self, scope: DocsScope) -> Option<&str> {
        match scope {
            DocsScope::Thread => Some(self.thread_collection.as_str()),
            DocsScope::Project => self.project_collection.as_deref(),
        }
    }

    /// The embedding session, if one is running. Prefers the upstream engine
    /// (mirroring the TS extension order) and the dedicated embedding model
    /// id, falling back to any `is_embedding` session. Each map is locked only
    /// long enough to copy port/key/model.
    async fn find_embedding_session(&self) -> Option<(i32, String, String)> {
        let mut fallback: Option<(i32, String, String)> = None;
        {
            let sessions = self.upstream_sessions.lock().await;
            for session in sessions.values() {
                if !session.info.is_embedding {
                    continue;
                }
                let candidate = (
                    session.info.port,
                    session.info.api_key.clone(),
                    session.info.model_id.clone(),
                );
                if model_ids_match(&session.info.model_id, EMBEDDING_MODEL_ID) {
                    return Some(candidate);
                }
                fallback.get_or_insert(candidate);
            }
        }
        {
            let sessions = self.llamacpp_sessions.lock().await;
            for session in sessions.values() {
                if !session.info.is_embedding {
                    continue;
                }
                let candidate = (
                    session.info.port,
                    session.info.api_key.clone(),
                    session.info.model_id.clone(),
                );
                if model_ids_match(&session.info.model_id, EMBEDDING_MODEL_ID) {
                    return Some(candidate);
                }
                fallback.get_or_insert(candidate);
            }
        }
        fallback
    }

    async fn run_blocking<T, F>(&self, operation: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce() -> Result<T, tauri_plugin_vector_db::VectorDBError> + Send + 'static,
    {
        tokio::task::spawn_blocking(operation)
            .await
            .map_err(|error| format!("Document index task failed: {error}"))?
            .map_err(map_vector_db_error)
    }
}

fn map_vector_db_error(error: tauri_plugin_vector_db::VectorDBError) -> String {
    let message = error.to_string();
    if message.to_lowercase().contains("dimension") {
        return "The document index was built with a different embedding model and needs \
                re-indexing; do not retry this tool."
            .into();
    }
    format!("Document index error: {message}; do not retry this tool")
}

#[async_trait]
impl DocsBridge for LiveDocsBridge {
    fn scopes(&self) -> &[DocsScope] {
        &self.scopes
    }

    async fn embed(
        &self,
        query: &str,
        cancellation: &CancellationToken,
    ) -> Result<Vec<f32>, String> {
        let Some((port, api_key, model_id)) = self.find_embedding_session().await else {
            return Err(EMBEDDING_UNAVAILABLE.into());
        };
        // Byte-for-byte the payload the TS extension sends.
        let payload = serde_json::json!({
            "input": [query],
            "model": model_id,
            "encoding_format": "float",
        });
        let mut builder = self
            .http
            .post(format!("http://127.0.0.1:{port}/v1/embeddings"))
            .json(&payload);
        if !api_key.is_empty() {
            builder = builder.bearer_auth(&api_key);
        }
        let response = tokio::select! {
            _ = cancellation.cancelled() => return Err("Tool call cancelled".into()),
            result = tokio::time::timeout(DOCS_EMBED_TIMEOUT, builder.send()) => match result {
                Ok(result) => result
                    .map_err(|error| format!("Embedding request failed: {error}; do not retry this tool"))?,
                Err(_) => {
                    return Err("Embedding request timed out; do not retry this tool".into());
                }
            },
        };
        if !response.status().is_success() {
            return Err(format!(
                "Embedding request failed with HTTP {}; do not retry this tool",
                response.status().as_u16()
            ));
        }
        let value: Value = response
            .json()
            .await
            .map_err(|error| format!("Embedding response was not JSON: {error}"))?;
        let embedding = value
            .pointer("/data/0/embedding")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_f64)
                    .map(|v| v as f32)
                    .collect::<Vec<f32>>()
            })
            .filter(|embedding| !embedding.is_empty())
            .ok_or("Embedding response carried no embedding vector")?;
        Ok(embedding)
    }

    async fn list(&self, scope: DocsScope) -> Result<Vec<DocsAttachment>, String> {
        let Some(collection) = self.collection_for(scope).map(str::to_owned) else {
            return Ok(Vec::new());
        };
        let base_dir = self.base_dir.clone();
        let attachments = self
            .run_blocking(move || {
                tauri_plugin_vector_db::api::list_attachments(&base_dir, &collection, None)
            })
            .await?;
        Ok(attachments
            .into_iter()
            .map(|info| DocsAttachment {
                id: info.id,
                name: info.name,
                file_type: info.file_type,
                size: info.size,
                chunk_count: info.chunk_count,
                scope: scope.as_str(),
            })
            .collect())
    }

    async fn retrieve(
        &self,
        scope: DocsScope,
        query_embedding: &[f32],
        top_k: usize,
        file_ids: Option<&[String]>,
    ) -> Result<Vec<DocsChunk>, String> {
        let Some(collection) = self.collection_for(scope).map(str::to_owned) else {
            return Ok(Vec::new());
        };
        let base_dir = self.base_dir.clone();
        let embedding = query_embedding.to_vec();
        let file_ids = file_ids.map(<[String]>::to_vec);
        let results = self
            .run_blocking(move || {
                tauri_plugin_vector_db::api::search_collection(
                    &base_dir,
                    &collection,
                    &embedding,
                    top_k,
                    0.0,
                    // Forced linear: uniform cosine scores that merge safely
                    // across collections (the ANN path returns distances and
                    // ignores the threshold).
                    Some("linear".into()),
                    file_ids,
                )
            })
            .await?;
        Ok(results
            .into_iter()
            .map(|result| DocsChunk {
                id: result.id,
                text: result.text,
                score: result.score,
                file_id: result.file_id,
                chunk_file_order: result.chunk_file_order,
                scope: scope.as_str(),
            })
            .collect())
    }

    async fn chunks(
        &self,
        scope: DocsScope,
        file_id: &str,
        start_order: i64,
        end_order: i64,
    ) -> Result<Vec<DocsChunk>, String> {
        let Some(collection) = self.collection_for(scope).map(str::to_owned) else {
            return Ok(Vec::new());
        };
        let base_dir = self.base_dir.clone();
        let file_id = file_id.to_owned();
        let results = self
            .run_blocking(move || {
                tauri_plugin_vector_db::api::get_chunks(
                    &base_dir,
                    &collection,
                    &file_id,
                    start_order,
                    end_order,
                )
            })
            .await?;
        Ok(results
            .into_iter()
            .map(|result| DocsChunk {
                id: result.id,
                text: result.text,
                score: None,
                file_id: result.file_id,
                chunk_file_order: result.chunk_file_order,
                scope: scope.as_str(),
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_parses_and_prints_symmetrically() {
        assert_eq!(DocsScope::parse("thread"), Some(DocsScope::Thread));
        assert_eq!(DocsScope::parse("project"), Some(DocsScope::Project));
        assert_eq!(DocsScope::parse("global"), None);
        assert_eq!(DocsScope::Thread.as_str(), "thread");
        assert_eq!(DocsScope::Project.as_str(), "project");
    }

    #[test]
    fn dimension_errors_map_to_a_reindex_message() {
        let error = tauri_plugin_vector_db::VectorDBError::InvalidInput(
            "Vector dimensions don't match".into(),
        );
        assert!(map_vector_db_error(error).contains("re-indexing"));
    }
}
