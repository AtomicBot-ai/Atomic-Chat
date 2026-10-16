//! Turning a `panel://` request path into a file on disk, or refusing to.
//!
//! This is the only place a panel's files are read from, so it is the only
//! place that has to be right about path escapes. The discipline is lifted
//! from the agent skills registry: canonicalise, then prove containment —
//! never trust a path because it looks relative.

use std::path::{Path, PathBuf};

/// Why a request was refused. The caller logs this; panels only ever see a
/// 403 or 404, never the reason, so a probe learns nothing from the response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RefusedPath {
    /// The request contained `..`, an absolute path, or a control character.
    Suspicious,
    /// It canonicalised to somewhere outside the panel's own folder, which is
    /// what a symlink pointing out of the folder looks like.
    Escapes,
    /// Nothing is there.
    Missing,
}

fn looks_suspicious(request: &str) -> bool {
    if request.starts_with('/') && request.len() == 1 {
        return false;
    }
    let trimmed = request.trim_start_matches('/');
    if trimmed.is_empty() {
        return false;
    }
    if Path::new(trimmed).is_absolute() {
        return true;
    }
    trimmed
        .split(['/', '\\'])
        .any(|segment| segment == ".." || segment.chars().any(char::is_control))
        || trimmed.contains('\0')
}

/// Resolve `request` inside `panel_root`. `entry` stands in for a bare `/`.
///
/// Returns the real path of an existing regular file inside the folder, or the
/// reason it was refused. A symlink is followed and then checked, so a link
/// pointing outside the folder is refused by containment rather than by
/// guessing at link semantics.
pub fn resolve_panel_file(
    panel_root: &Path,
    request: &str,
    entry: &str,
) -> Result<PathBuf, RefusedPath> {
    let relative = match request.trim_start_matches('/') {
        "" => entry,
        other => other,
    };
    if looks_suspicious(relative) || looks_suspicious(entry) {
        return Err(RefusedPath::Suspicious);
    }

    let canonical_root = panel_root
        .canonicalize()
        .map_err(|_| RefusedPath::Missing)?;
    let candidate = canonical_root.join(relative);
    let canonical = candidate.canonicalize().map_err(|_| RefusedPath::Missing)?;

    if !canonical.starts_with(&canonical_root) {
        return Err(RefusedPath::Escapes);
    }
    if !canonical.is_file() {
        return Err(RefusedPath::Missing);
    }
    Ok(canonical)
}

/// Content type for a file a panel asked for. Deliberately a short list: a
/// panel that wants something exotic can inline it, and an unknown extension
/// is served as bytes rather than guessed at.
pub fn content_type_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    }
}
