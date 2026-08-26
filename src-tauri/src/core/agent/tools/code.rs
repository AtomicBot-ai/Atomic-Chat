//! Syntax-aware code navigation.
//!
//! Before these, the agent's only way around a repository was `os.fs.glob` and
//! `os.fs.grep` — text matching with no idea what a symbol is. These answer
//! "what is declared here", "where is this defined" and "where is this used"
//! from a parsed syntax tree instead.
//!
//! Boundary worth keeping in mind: this is *syntax*, not semantics. Two
//! same-named symbols in unrelated modules are indistinguishable, which is why
//! the tool descriptors say so outright — a model that believes otherwise will
//! confidently edit the wrong one.

use std::path::PathBuf;

use atomic_code_index::{
    find_references, symbols_in_source, CodeIndex, IndexLimits, Language, MatchMode, SymbolKind,
};
use serde_json::Value;

use super::{optional_usize, required_string, truncate, ToolContext, MAX_TOOL_OUTPUT_CHARS};
use crate::core::agent::types::ToolOutcome;

const DEFAULT_FIND_LIMIT: usize = 50;
const MAX_FIND_LIMIT: usize = 500;
const DEFAULT_REFS_LIMIT: usize = 100;
const MAX_REFS_LIMIT: usize = 1_000;

pub async fn execute(
    tool: &str,
    args: &Value,
    context: &ToolContext<'_>,
) -> Result<ToolOutcome, ToolOutcome> {
    match tool {
        "os.code.symbols" => symbols(args, context).await,
        "os.code.find" => find(args, context).await,
        "os.code.refs" => refs(args, context).await,
        _ => Err(ToolOutcome::error(format!("Unsupported code tool: {tool}"))),
    }
}

async fn symbols(args: &Value, _context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    // `path` is already resolved and root-checked by `path_policy`.
    let path = PathBuf::from(required_string(args, "path").map_err(ToolOutcome::error)?);
    let Some(language) = Language::from_path(&path) else {
        return Err(ToolOutcome::error(format!(
            "No parser for {}; supported extensions are .rs, .ts, .tsx, .js, .jsx, .py",
            path.display()
        )));
    };
    let source = tokio::fs::read_to_string(&path).await.map_err(|error| {
        ToolOutcome::error(format!("Could not read {}: {error}", path.display()))
    })?;
    let symbols = symbols_in_source(language, &source)
        .ok_or_else(|| ToolOutcome::error(format!("Could not parse {}", path.display())))?;
    if symbols.is_empty() {
        return Ok(ToolOutcome::ok(format!(
            "No top-level definitions found in {}",
            path.display()
        )));
    }
    let body = symbols
        .iter()
        .map(|symbol| format!("{}\t{}\t{}", symbol.line, symbol.kind.as_str(), symbol.name))
        .collect::<Vec<_>>()
        .join("\n");
    Ok(ToolOutcome::ok(truncate(
        format!(
            "{} definitions in {} (line\tkind\tname):\n{body}",
            symbols.len(),
            path.display()
        ),
        MAX_TOOL_OUTPUT_CHARS,
    )))
}

async fn find(args: &Value, context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let name = required_string(args, "name").map_err(ToolOutcome::error)?;
    let kind = match args.get("kind").and_then(Value::as_str) {
        Some(value) => Some(SymbolKind::parse(value).ok_or_else(|| {
            ToolOutcome::error(format!(
                "Unsupported kind `{value}`; use class, struct, enum, trait, interface, method, function, macro, type, module, or constant"
            ))
        })?),
        None => None,
    };
    let limit = optional_usize(args, "limit", DEFAULT_FIND_LIMIT, MAX_FIND_LIMIT);
    // Only the workspace roots the user connected. Indexing anything wider
    // would turn code navigation into a way around the folder-access prompt.
    let roots = context.editable_roots.snapshot().await;
    let cache_dir = context.cache_dir.to_path_buf();
    let needle = name.clone();

    let rendered = tokio::task::spawn_blocking(move || {
        let limits = IndexLimits::default();
        let mut lines = Vec::new();
        let mut modes = Vec::new();
        let mut truncated = false;
        for root in roots {
            let mut index = CodeIndex::load_or_empty(&cache_dir, &root);
            let stats = index.refresh(&limits);
            truncated |= stats.truncated;
            if let Err(error) = index.save(&cache_dir) {
                // A cache we cannot persist only costs time on the next call.
                log::warn!("[code-index] could not cache {}: {error}", root.display());
            }
            let (hits, mode) = index.find(&needle, kind, limit);
            if !hits.is_empty() {
                modes.push(mode);
            }
            for hit in hits {
                lines.push(format!(
                    "{}/{}:{}\t{}\t{}",
                    root.display(),
                    hit.path,
                    hit.symbol.line,
                    hit.symbol.kind.as_str(),
                    hit.symbol.name
                ));
            }
        }
        (lines, modes, truncated)
    })
    .await
    .map_err(|error| ToolOutcome::error(error.to_string()))?;

    let (lines, modes, truncated) = rendered;
    if lines.is_empty() {
        let caveat = if truncated {
            " The index hit its size limit, so this is not proof the symbol is absent."
        } else {
            ""
        };
        return Ok(ToolOutcome::ok(format!(
            "No definition of `{name}` in the connected workspace roots.{caveat}"
        )));
    }
    let mut header = format!("{} definition(s) of `{name}`", lines.len());
    if modes
        .iter()
        .all(|mode| *mode == MatchMode::CaseInsensitiveSubstring)
    {
        header.push_str(" — no exact match, showing case-insensitive partial matches");
    }
    if truncated {
        header.push_str(" (index truncated: results may be incomplete)");
    }
    Ok(ToolOutcome::ok(truncate(
        format!("{header}:\n{}", lines.join("\n")),
        MAX_TOOL_OUTPUT_CHARS,
    )))
}

async fn refs(args: &Value, _context: &ToolContext<'_>) -> Result<ToolOutcome, ToolOutcome> {
    let name = required_string(args, "name").map_err(ToolOutcome::error)?;
    // `path` is resolved by `path_policy`, defaulting to the working directory.
    let root = PathBuf::from(required_string(args, "path").map_err(ToolOutcome::error)?);
    let limit = optional_usize(args, "limit", DEFAULT_REFS_LIMIT, MAX_REFS_LIMIT);

    let needle = name.clone();
    let scan = tokio::task::spawn_blocking(move || {
        find_references(&root, &needle, &IndexLimits::default(), limit)
    })
    .await
    .map_err(|error| ToolOutcome::error(error.to_string()))?;

    if scan.references.is_empty() {
        return Ok(ToolOutcome::ok(format!(
            "No identifier occurrences of `{name}` in {} scanned file(s).",
            scan.files_scanned
        )));
    }
    let body = scan
        .references
        .iter()
        .map(|reference| format!("{}:{}\t{}", reference.path, reference.line, reference.text))
        .collect::<Vec<_>>()
        .join("\n");
    let mut header = format!(
        "{} occurrence(s) of `{name}` across {} file(s)",
        scan.references.len(),
        scan.files_scanned
    );
    if scan.truncated {
        header.push_str(&format!(" — stopped at the {limit} result limit"));
    }
    // Said every time on purpose: the results look authoritative, and they are
    // not. A same-named symbol from another module is in here too.
    header.push_str(
        ". These are identifier matches, not resolved references: same-named \
         symbols from other modules are included.",
    );
    Ok(ToolOutcome::ok(truncate(
        format!("{header}\n{body}"),
        MAX_TOOL_OUTPUT_CHARS,
    )))
}
