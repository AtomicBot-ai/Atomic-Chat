//! Public read-only API for in-process consumers (the Rust agent's `docs.*`
//! tools). The Tauri commands keep delegating to the same `db` internals;
//! this module exists so `src-tauri` core code can query collections without
//! going through IPC.
//!
//! Contracts:
//! - A missing collection returns `Ok(vec![])` and **never creates a `.db`
//!   file** — the write path (`open_or_init_conn`) creates files on open, so
//!   reads must check existence first or every document-less thread would
//!   litter empty databases.
//! - Every call opens a fresh short-lived connection with a 5s busy timeout:
//!   the TypeScript chat pipeline may be ingesting into the same file
//!   concurrently.
//! - `rusqlite::Connection` is `!Send`; callers on async runtimes must wrap
//!   these in `spawn_blocking`.

use std::path::Path;
use std::time::Duration;

use rusqlite::Connection;

pub use crate::db::{AttachmentFileInfo, SearchResult};
use crate::VectorDBError;

const READ_BUSY_TIMEOUT: Duration = Duration::from_secs(5);

fn open_existing(base_dir: &Path, collection: &str) -> Result<Option<Connection>, VectorDBError> {
    let path = crate::db::collection_path(&base_dir.to_path_buf(), collection);
    if !path.exists() {
        return Ok(None);
    }
    let conn = Connection::open(&path)?;
    conn.busy_timeout(READ_BUSY_TIMEOUT)?;
    Ok(Some(conn))
}

/// Search one collection. `mode: Some("linear")` skips the sqlite-vec
/// extension dance entirely and returns cosine similarities (higher = better);
/// other modes may take the ANN path, whose `score` is a distance (lower =
/// better) and ignores `threshold` — callers merging results across
/// collections should force linear.
pub fn search_collection(
    base_dir: &Path,
    collection: &str,
    query_embedding: &[f32],
    limit: usize,
    threshold: f32,
    mode: Option<String>,
    file_ids: Option<Vec<String>>,
) -> Result<Vec<SearchResult>, VectorDBError> {
    let Some(conn) = open_existing(base_dir, collection)? else {
        return Ok(Vec::new());
    };
    let force_linear = mode.as_deref() == Some("linear");
    let vec_loaded = if force_linear {
        false
    } else {
        crate::db::try_load_sqlite_vec(&conn)
    };
    crate::db::search_collection(
        &conn,
        query_embedding,
        limit,
        threshold,
        mode,
        vec_loaded,
        file_ids,
    )
}

pub fn list_attachments(
    base_dir: &Path,
    collection: &str,
    limit: Option<usize>,
) -> Result<Vec<AttachmentFileInfo>, VectorDBError> {
    let Some(conn) = open_existing(base_dir, collection)? else {
        return Ok(Vec::new());
    };
    crate::db::list_attachments(&conn, limit)
}

pub fn get_chunks(
    base_dir: &Path,
    collection: &str,
    file_id: &str,
    start_order: i64,
    end_order: i64,
) -> Result<Vec<SearchResult>, VectorDBError> {
    let Some(conn) = open_existing(base_dir, collection)? else {
        return Ok(Vec::new());
    };
    crate::db::get_chunks(&conn, file_id.to_owned(), start_order, end_order)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{self, MinimalChunkInput};

    fn seeded_collection(base: &Path, name: &str) -> String {
        let path = db::collection_path(&base.to_path_buf(), name);
        let conn = db::open_or_init_conn(&path).expect("open collection");
        db::create_schema(&conn, 4).expect("schema");
        let file = db::create_file(
            &conn,
            "/tmp/doc.pdf",
            Some("doc.pdf"),
            Some("pdf"),
            Some(1024),
        )
        .expect("create file");
        let file_id = file.id;
        // Orthogonal-ish embeddings with known cosine ordering vs [1,0,0,0].
        let chunks = vec![
            MinimalChunkInput {
                text: "exact match".into(),
                embedding: vec![1.0, 0.0, 0.0, 0.0],
            },
            MinimalChunkInput {
                text: "close match".into(),
                embedding: vec![0.9, 0.1, 0.0, 0.0],
            },
            MinimalChunkInput {
                text: "far away".into(),
                embedding: vec![0.0, 0.0, 1.0, 0.0],
            },
        ];
        db::insert_chunks(&conn, &file_id, chunks, false).expect("insert");
        file_id
    }

    #[test]
    fn missing_collection_returns_empty_without_creating_a_db_file() {
        let temp = tempfile::tempdir().expect("tempdir");
        let results =
            search_collection(temp.path(), "attachments_missing", &[1.0, 0.0, 0.0, 0.0], 3, 0.0, Some("linear".into()), None)
                .expect("search");
        assert!(results.is_empty());
        assert!(list_attachments(temp.path(), "attachments_missing", None)
            .expect("list")
            .is_empty());
        assert!(get_chunks(temp.path(), "attachments_missing", "f", 0, 10)
            .expect("chunks")
            .is_empty());
        assert!(
            !db::collection_path(&temp.path().to_path_buf(), "attachments_missing").exists(),
            "read path must not create database files"
        );
    }

    #[test]
    fn linear_search_orders_by_cosine_similarity() {
        let temp = tempfile::tempdir().expect("tempdir");
        seeded_collection(temp.path(), "attachments_t1");

        let results = search_collection(
            temp.path(),
            "attachments_t1",
            &[1.0, 0.0, 0.0, 0.0],
            3,
            0.0,
            Some("linear".into()),
            None,
        )
        .expect("search");

        assert_eq!(results[0].text, "exact match");
        assert_eq!(results[1].text, "close match");
        let first = results[0].score.expect("score");
        let second = results[1].score.expect("score");
        assert!(first >= second, "cosine similarity descends");
    }

    #[test]
    fn file_ids_filter_and_chunk_range_are_inclusive() {
        let temp = tempfile::tempdir().expect("tempdir");
        let file_id = seeded_collection(temp.path(), "attachments_t2");

        let filtered = search_collection(
            temp.path(),
            "attachments_t2",
            &[1.0, 0.0, 0.0, 0.0],
            5,
            0.0,
            Some("linear".into()),
            Some(vec!["not-a-file".into()]),
        )
        .expect("search");
        assert!(filtered.is_empty());

        let chunks =
            get_chunks(temp.path(), "attachments_t2", &file_id, 0, 1).expect("chunks");
        assert_eq!(chunks.len(), 2, "range is inclusive and 0-indexed");
        assert_eq!(chunks[0].chunk_file_order, 0);
        assert_eq!(chunks[1].chunk_file_order, 1);
    }

    #[test]
    fn dimension_mismatch_is_an_input_error() {
        let temp = tempfile::tempdir().expect("tempdir");
        seeded_collection(temp.path(), "attachments_t3");

        let result = search_collection(
            temp.path(),
            "attachments_t3",
            &[1.0, 0.0],
            3,
            0.0,
            Some("linear".into()),
            None,
        );
        assert!(result.is_err());
    }
}
