//! Dispatch for the document-index tools `docs.list` / `docs.retrieve` /
//! `docs.chunks`. Mirrors the chat pipeline's RAG tool contracts
//! (`extensions/rag-extension/src/tools.ts`): JSON payload in the model-visible
//! summary, no raw scoring surprises (linear cosine only — see `rag_bridge`).

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};

use super::{ToolContext, MAX_TOOL_OUTPUT_CHARS};
use crate::core::agent::rag_bridge::{DocsAttachment, DocsBridge, DocsChunk, DocsScope};
use crate::core::agent::types::ToolOutcome;

pub const DOCS_TOOL_NAMES: [&str; 3] = ["docs.list", "docs.retrieve", "docs.chunks"];
pub const DOCS_DEFAULT_TOP_K: usize = 5;
pub const DOCS_MAX_TOP_K: usize = 10;
pub const DOCS_MAX_QUERIES: usize = 5;
pub const DOCS_MAX_CHUNK_RANGE: i64 = 100;
/// Citation label of a passage whose file is no longer listed.
const REMOVED_SOURCE: &str = "removed document";
/// Citation label of a passage whose scope could not be listed.
const UNKNOWN_SOURCE: &str = "document";

pub(super) async fn execute(tool: &str, args: &Value, context: &ToolContext<'_>) -> ToolOutcome {
    let Some(bridge) = context.docs else {
        return ToolOutcome::error("Document tools are not available this turn");
    };
    let scope = match parse_scope(args) {
        Ok(scope) => scope,
        Err(message) => return ToolOutcome::error(message),
    };
    if let Some(scope) = scope {
        if !bridge.scopes().contains(&scope) {
            return ToolOutcome::error(
                "No project documents are configured for this thread; omit `scope` or use \
                 `\"thread\"`",
            );
        }
    }
    let scopes: Vec<DocsScope> = match scope {
        Some(scope) => vec![scope],
        None => bridge.scopes().to_vec(),
    };

    let result = match tool {
        "docs.list" => list(bridge, &scopes).await,
        "docs.retrieve" => retrieve(bridge, &scopes, args, context).await,
        "docs.chunks" => chunks(bridge, &scopes, args).await,
        _ => Err(format!("Unknown docs tool: {tool}")),
    };
    match result {
        Ok(payload) => {
            let mut summary = payload.to_string();
            let truncated = summary.chars().count() > MAX_TOOL_OUTPUT_CHARS;
            if truncated {
                summary = summary.chars().take(MAX_TOOL_OUTPUT_CHARS).collect();
                summary.push('…');
            }
            ToolOutcome {
                status: crate::core::agent::types::ToolStatus::Ok,
                summary,
                details: Some(json!({
                    "docs": true,
                    "scopes": scopes.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
                    "mode": "linear",
                    "truncated": truncated,
                })),
            }
        }
        Err(message) => ToolOutcome::error(message),
    }
}

async fn list(bridge: &dyn DocsBridge, scopes: &[DocsScope]) -> Result<Value, String> {
    let mut attachments = Vec::new();
    for scope in scopes {
        attachments.extend(bridge.list(*scope).await?);
    }
    Ok(json!({ "attachments": attachments }))
}

async fn retrieve(
    bridge: &dyn DocsBridge,
    scopes: &[DocsScope],
    args: &Value,
    context: &ToolContext<'_>,
) -> Result<Value, String> {
    let queries = parse_queries(args)?;
    let top_k = parse_top_k(args)?;
    let file_ids = parse_file_ids(args)?;

    let mut per_query: Vec<Vec<DocsChunk>> = Vec::with_capacity(queries.len());
    for query in &queries {
        let embedding = bridge.embed(query, context.cancellation).await?;
        let mut hits: Vec<DocsChunk> = Vec::new();
        for scope in scopes {
            hits.extend(
                bridge
                    .retrieve(*scope, &embedding, top_k, file_ids.as_deref(), Some(query))
                    .await?,
            );
        }
        // Uniform cosine similarities (linear mode) merge safely across scopes.
        hits.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        per_query.push(hits);
    }

    let hits = merge_hits(&queries, per_query, top_k);
    let listings = list_cited_scopes(bridge, &hits).await;
    let (citations, sources) = cite(hits, &listings, queries.len() > 1);
    Ok(json!({
        "queries": queries,
        "citations": citations,
        "sources": sources,
        "mode": "linear",
    }))
}

struct MergedHit {
    chunk: DocsChunk,
    score: f32,
    matched: Vec<String>,
}

/// One list from the per-query results (each best first). A passage found by
/// several queries appears once, with its best score and every query that
/// found it. Each query's best passage is kept before the rest compete on
/// score, so one strongly matching fact cannot crowd the others out.
fn merge_hits(queries: &[String], per_query: Vec<Vec<DocsChunk>>, top_k: usize) -> Vec<MergedHit> {
    let mut merged: Vec<MergedHit> = Vec::new();
    let mut index_of: HashMap<(&'static str, String), usize> = HashMap::new();
    let mut best_of_query: Vec<usize> = Vec::new();
    for (query, hits) in queries.iter().zip(per_query) {
        for (rank, chunk) in hits.into_iter().enumerate() {
            let key = (chunk.scope, chunk.id.clone());
            let score = chunk.score.unwrap_or(0.0);
            let index = match index_of.get(&key) {
                Some(&index) => {
                    let hit = &mut merged[index];
                    hit.score = hit.score.max(score);
                    if !hit.matched.contains(query) {
                        hit.matched.push(query.clone());
                    }
                    index
                }
                None => {
                    merged.push(MergedHit {
                        chunk,
                        score,
                        matched: vec![query.clone()],
                    });
                    index_of.insert(key, merged.len() - 1);
                    merged.len() - 1
                }
            };
            if rank == 0 {
                best_of_query.push(index);
            }
        }
    }

    let mut order: Vec<usize> = (0..merged.len()).collect();
    order.sort_by(|&a, &b| {
        merged[b]
            .score
            .partial_cmp(&merged[a].score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut keep = vec![false; merged.len()];
    let mut kept = 0;
    for index in best_of_query.into_iter().chain(order.iter().copied()) {
        if kept == top_k {
            break;
        }
        if !keep[index] {
            keep[index] = true;
            kept += 1;
        }
    }
    let mut slots: Vec<Option<MergedHit>> = merged.into_iter().map(Some).collect();
    order
        .into_iter()
        .filter(|&index| keep[index])
        .filter_map(|index| slots[index].take())
        .collect()
}

/// The attachments of every scope a hit came from, listed once per scope;
/// `None` for a scope whose listing failed.
async fn list_cited_scopes(
    bridge: &dyn DocsBridge,
    hits: &[MergedHit],
) -> HashMap<&'static str, Option<HashMap<String, DocsAttachment>>> {
    let mut listings = HashMap::new();
    for hit in hits {
        let Some(scope) = DocsScope::parse(hit.chunk.scope) else {
            continue;
        };
        if listings.contains_key(scope.as_str()) {
            continue;
        }
        let files = bridge.list(scope).await.ok().map(|files| {
            files
                .into_iter()
                .map(|file| (file.id.clone(), file))
                .collect::<HashMap<_, _>>()
        });
        listings.insert(scope.as_str(), files);
    }
    listings
}

/// Readable citations for the model to copy: `[FINDINGS.md §13]` names the
/// file and the 1-based passage, never the chunk or file ids. `sources`
/// carries what the UI needs to open a cited file.
fn cite(
    hits: Vec<MergedHit>,
    listings: &HashMap<&'static str, Option<HashMap<String, DocsAttachment>>>,
    with_matched: bool,
) -> (Vec<Value>, Vec<Value>) {
    let mut sources = Vec::new();
    let mut seen = HashSet::new();
    let citations = hits
        .into_iter()
        .map(|hit| {
            let chunk = hit.chunk;
            let listing = listings.get(chunk.scope).and_then(Option::as_ref);
            let file = listing.and_then(|files| files.get(&chunk.file_id));
            let name = match (listing, file) {
                (_, Some(file)) => file
                    .name
                    .clone()
                    .or_else(|| {
                        file.path
                            .as_deref()
                            .and_then(|path| path.rsplit(['/', '\\']).next())
                            .filter(|name| !name.is_empty())
                            .map(str::to_owned)
                    })
                    .unwrap_or_else(|| UNKNOWN_SOURCE.to_owned()),
                (Some(_), None) => REMOVED_SOURCE.to_owned(),
                (None, _) => UNKNOWN_SOURCE.to_owned(),
            };
            if let Some(file) = file {
                if seen.insert((chunk.scope, file.id.clone())) {
                    sources.push(json!({
                        "file_id": file.id,
                        "name": name,
                        "path": file.path,
                        "passages": file.chunk_count,
                        "scope": chunk.scope,
                    }));
                }
            }
            let passage = chunk.chunk_file_order + 1;
            // Brackets in a file name would end the label early.
            let label = name.replace('[', "(").replace(']', ")");
            let mut citation = json!({
                "cite": format!("[{label} §{passage}]"),
                "source": name,
                "passage": passage,
                "text": chunk.text,
                "score": hit.score,
                "file_id": chunk.file_id,
                "chunk_file_order": chunk.chunk_file_order,
                "scope": chunk.scope,
            });
            if listing.is_some() && file.is_none() {
                citation["removed"] = json!(true);
            }
            if with_matched {
                citation["matched"] = json!(hit.matched);
            }
            citation
        })
        .collect();
    (citations, sources)
}

async fn chunks(
    bridge: &dyn DocsBridge,
    scopes: &[DocsScope],
    args: &Value,
) -> Result<Value, String> {
    let file_id = required_non_empty_str(args, "file_id")?;
    let start_order = required_i64(args, "start_order")?;
    let end_order = required_i64(args, "end_order")?;
    if start_order < 0 {
        return Err("start_order must be >= 0".into());
    }
    if end_order < start_order {
        return Err("end_order must be >= start_order".into());
    }
    if end_order - start_order >= DOCS_MAX_CHUNK_RANGE {
        return Err(format!(
            "Chunk range is capped at {DOCS_MAX_CHUNK_RANGE} chunks per call; narrow the range"
        ));
    }

    for scope in scopes {
        let result = bridge
            .chunks(*scope, file_id, start_order, end_order)
            .await?;
        if !result.is_empty() {
            return Ok(json!({
                "file_id": file_id,
                "scope": scope.as_str(),
                "chunks": result,
            }));
        }
    }
    Ok(json!({
        "file_id": file_id,
        "chunks": [],
        "note": "file_id not found in any collection",
    }))
}

fn parse_scope(args: &Value) -> Result<Option<DocsScope>, String> {
    match args.get("scope") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(raw)) => DocsScope::parse(raw)
            .map(Some)
            .ok_or_else(|| format!("scope must be \"thread\" or \"project\", got {raw:?}")),
        Some(_) => Err("scope must be a string".into()),
    }
}

/// `query` and `queries` together: trimmed, deduplicated, at most
/// `DOCS_MAX_QUERIES`, and at least one.
fn parse_queries(args: &Value) -> Result<Vec<String>, String> {
    let mut candidates: Vec<&Value> = Vec::new();
    if let Some(query) = args.get("query").filter(|value| !value.is_null()) {
        candidates.push(query);
    }
    match args.get("queries") {
        None | Some(Value::Null) => {}
        Some(Value::Array(values)) => candidates.extend(values),
        Some(_) => return Err("queries must be an array of strings".into()),
    }
    let mut queries: Vec<String> = Vec::new();
    for candidate in candidates {
        let query = candidate
            .as_str()
            .ok_or("query and queries entries must be strings")?
            .trim();
        if query.is_empty()
            || queries
                .iter()
                .any(|seen| seen.to_lowercase() == query.to_lowercase())
        {
            continue;
        }
        queries.push(query.to_owned());
        if queries.len() == DOCS_MAX_QUERIES {
            break;
        }
    }
    if queries.is_empty() {
        return Err(
            "query must be a non-empty string, or queries a non-empty array of strings".into(),
        );
    }
    Ok(queries)
}

fn parse_top_k(args: &Value) -> Result<usize, String> {
    match args.get("top_k") {
        None | Some(Value::Null) => Ok(DOCS_DEFAULT_TOP_K),
        Some(value) => {
            let requested = value
                .as_u64()
                .or_else(|| {
                    value
                        .as_f64()
                        .filter(|v| v.fract() == 0.0)
                        .map(|v| v as u64)
                })
                .ok_or("top_k must be a positive integer")?;
            if requested == 0 {
                return Err("top_k must be at least 1".into());
            }
            Ok((requested as usize).min(DOCS_MAX_TOP_K))
        }
    }
}

fn parse_file_ids(args: &Value) -> Result<Option<Vec<String>>, String> {
    match args.get("file_ids") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(values)) => {
            let ids = values
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .map(str::trim)
                        .filter(|id| !id.is_empty())
                        .map(str::to_owned)
                        .ok_or("file_ids entries must be non-empty strings")
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok((!ids.is_empty()).then_some(ids))
        }
        Some(_) => Err("file_ids must be an array of strings".into()),
    }
}

fn required_non_empty_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{key} must be a non-empty string"))
}

fn required_i64(args: &Value, key: &str) -> Result<i64, String> {
    args.get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("{key} must be an integer"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn top_k_defaults_and_clamps() {
        assert_eq!(parse_top_k(&json!({})).unwrap(), DOCS_DEFAULT_TOP_K);
        assert_eq!(parse_top_k(&json!({"top_k": 5})).unwrap(), 5);
        assert_eq!(parse_top_k(&json!({"top_k": 99})).unwrap(), DOCS_MAX_TOP_K);
        assert!(parse_top_k(&json!({"top_k": 0})).is_err());
        assert!(parse_top_k(&json!({"top_k": "three"})).is_err());
    }

    #[test]
    fn queries_merge_with_query_trim_dedupe_and_cap() {
        assert_eq!(
            parse_queries(&json!({"query": " probe timeout ", "queries": ["Probe Timeout", "", "MiniLM dimension"]}))
                .unwrap(),
            ["probe timeout", "MiniLM dimension"]
        );
        let many: Vec<String> = (0..8).map(|i| format!("fact {i}")).collect();
        assert_eq!(
            parse_queries(&json!({ "queries": many })).unwrap().len(),
            DOCS_MAX_QUERIES
        );
        assert!(parse_queries(&json!({})).is_err());
        assert!(parse_queries(&json!({"queries": ["  "]})).is_err());
        assert!(parse_queries(&json!({"queries": "one"})).is_err());
    }

    fn chunk(scope: &'static str, id: &str, order: i64, score: f32) -> DocsChunk {
        DocsChunk {
            id: id.into(),
            text: format!("passage {id}"),
            score: Some(score),
            file_id: "file-1".into(),
            chunk_file_order: order,
            scope,
        }
    }

    #[test]
    fn merge_keeps_each_querys_best_passage_once() {
        let queries = vec!["first".to_owned(), "second".to_owned(), "third".to_owned()];
        let per_query = vec![
            vec![chunk("project", "a", 2, 0.9), chunk("project", "b", 3, 0.8)],
            vec![chunk("project", "c", 4, 0.5), chunk("project", "a", 2, 0.6)],
            vec![chunk("project", "d", 6, 0.4)],
        ];

        let merged = merge_hits(&queries, per_query, 3);

        let ids: Vec<&str> = merged.iter().map(|hit| hit.chunk.id.as_str()).collect();
        // `b` outscores `c` and `d`, but each query keeps its best passage.
        assert_eq!(ids, ["a", "c", "d"]);
        assert_eq!(merged[0].matched, ["first", "second"]);
        assert_eq!(merged[0].score, 0.9);
    }

    #[test]
    fn citations_name_the_file_and_flag_a_removed_one() {
        let listing = HashMap::from([(
            "file-1".to_owned(),
            DocsAttachment {
                id: "file-1".into(),
                name: Some("FINDINGS.md".into()),
                path: Some("/docs/FINDINGS.md".into()),
                file_type: None,
                size: None,
                chunk_count: 42,
                scope: "project",
            },
        )]);
        let listings =
            HashMap::from([("project", Some(listing)), ("thread", Some(HashMap::new()))]);
        let hits = vec![
            MergedHit {
                chunk: chunk("project", "a", 12, 0.9),
                score: 0.9,
                matched: vec!["q".into()],
            },
            MergedHit {
                chunk: chunk("thread", "b", 0, 0.5),
                score: 0.5,
                matched: vec!["q".into()],
            },
        ];

        let (citations, sources) = cite(hits, &listings, false);

        assert_eq!(citations[0]["cite"], "[FINDINGS.md §13]");
        assert_eq!(citations[0]["passage"], 13);
        assert!(citations[0].get("removed").is_none());
        assert!(citations[0].get("id").is_none());
        assert_eq!(citations[1]["cite"], "[removed document §1]");
        assert_eq!(citations[1]["removed"], true);
        assert_eq!(
            sources,
            [json!({
                "file_id": "file-1",
                "name": "FINDINGS.md",
                "path": "/docs/FINDINGS.md",
                "passages": 42,
                "scope": "project",
            })]
        );
    }

    #[test]
    fn scope_and_file_ids_validate() {
        assert_eq!(parse_scope(&json!({})).unwrap(), None);
        assert_eq!(
            parse_scope(&json!({"scope": "project"})).unwrap(),
            Some(DocsScope::Project)
        );
        assert!(parse_scope(&json!({"scope": "everything"})).is_err());
        assert!(parse_file_ids(&json!({"file_ids": ["a", ""]})).is_err());
        assert_eq!(
            parse_file_ids(&json!({"file_ids": ["a", "b"]})).unwrap(),
            Some(vec!["a".into(), "b".into()])
        );
        assert_eq!(parse_file_ids(&json!({"file_ids": []})).unwrap(), None);
    }
}
