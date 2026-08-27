//! Dispatch for the document-index tools `docs.list` / `docs.retrieve` /
//! `docs.chunks`. Mirrors the chat pipeline's RAG tool contracts
//! (`extensions/rag-extension/src/tools.ts`): JSON payload in the model-visible
//! summary, no raw scoring surprises (linear cosine only — see `rag_bridge`).

use serde_json::{json, Value};

use super::{ToolContext, MAX_TOOL_OUTPUT_CHARS};
use crate::core::agent::rag_bridge::{DocsBridge, DocsChunk, DocsScope};
use crate::core::agent::types::ToolOutcome;

pub const DOCS_TOOL_NAMES: [&str; 3] = ["docs.list", "docs.retrieve", "docs.chunks"];
pub const DOCS_DEFAULT_TOP_K: usize = 3;
pub const DOCS_MAX_TOP_K: usize = 10;
pub const DOCS_MAX_CHUNK_RANGE: i64 = 100;

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
    let query = required_non_empty_str(args, "query")?;
    let top_k = parse_top_k(args)?;
    let file_ids = parse_file_ids(args)?;

    let embedding = bridge.embed(query, context.cancellation).await?;
    let mut citations: Vec<DocsChunk> = Vec::new();
    for scope in scopes {
        citations.extend(
            bridge
                .retrieve(*scope, &embedding, top_k, file_ids.as_deref())
                .await?,
        );
    }
    // Uniform cosine similarities (linear mode) merge safely across scopes.
    citations.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    citations.truncate(top_k);
    Ok(json!({ "query": query, "citations": citations, "mode": "linear" }))
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
        let result = bridge.chunks(*scope, file_id, start_order, end_order).await?;
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

fn parse_top_k(args: &Value) -> Result<usize, String> {
    match args.get("top_k") {
        None | Some(Value::Null) => Ok(DOCS_DEFAULT_TOP_K),
        Some(value) => {
            let requested = value
                .as_u64()
                .or_else(|| value.as_f64().filter(|v| v.fract() == 0.0).map(|v| v as u64))
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
