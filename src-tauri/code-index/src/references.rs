//! Syntax-aware occurrence search.
//!
//! This is the honest middle ground between `os.fs.grep` and real name
//! resolution. It parses each candidate file and reports only identifier
//! nodes, so matches inside comments and string literals — the bulk of grep's
//! noise — never appear. It still cannot tell two same-named symbols from
//! different modules apart, and callers must say so rather than implying that
//! it can.

use std::path::Path;

use ignore::WalkBuilder;

use crate::index::IndexLimits;
use crate::parser::{identifier_occurrences, Language};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reference {
    /// Relative to the scanned root, `/`-separated.
    pub path: String,
    pub line: u32,
    /// The source line, trimmed. Enough context to judge a hit without opening
    /// the file.
    pub text: String,
}

#[derive(Debug, Clone, Default)]
pub struct ReferenceScan {
    pub references: Vec<Reference>,
    pub files_scanned: usize,
    /// The limit cut the scan short: absence of a hit proves nothing.
    pub truncated: bool,
}

/// Longest line worth quoting back. Minified or generated code produces lines
/// that would otherwise fill the model's context on their own.
const MAX_LINE_CHARS: usize = 400;

/// Find identifier occurrences of `name` under `root`, which may be a single
/// file or a directory.
pub fn find_references(
    root: &Path,
    name: &str,
    limits: &IndexLimits,
    limit: usize,
) -> ReferenceScan {
    let mut scan = ReferenceScan::default();
    if name.is_empty() {
        return scan;
    }

    // Same filters as the index and as os.fs.grep, so all three agree on what
    // the workspace contains.
    let walker = WalkBuilder::new(root)
        .follow_links(false)
        .standard_filters(true)
        .build();

    for entry in walker.filter_map(Result::ok) {
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let path = entry.path();
        let Some(language) = Language::from_path(path) else {
            continue;
        };
        if entry
            .metadata()
            .is_ok_and(|metadata| metadata.len() > limits.max_file_bytes)
        {
            continue;
        }
        let Ok(source) = std::fs::read_to_string(path) else {
            continue;
        };
        scan.files_scanned += 1;
        // Cheap reject before paying for a parse. Most files in a tree do not
        // contain the name at all, and parsing them all is the slow way to
        // learn that.
        if !source.contains(name) {
            continue;
        }
        let Some(lines) = identifier_occurrences(language, &source, name) else {
            continue;
        };
        if lines.is_empty() {
            continue;
        }
        let relative = relative_key(root, path);
        let source_lines: Vec<&str> = source.lines().collect();
        for line in lines {
            if scan.references.len() >= limit {
                scan.truncated = true;
                return scan;
            }
            let text = source_lines
                .get(line as usize - 1)
                .map(|value| truncate_chars(value.trim(), MAX_LINE_CHARS))
                .unwrap_or_default();
            scan.references.push(Reference {
                path: relative.clone(),
                line,
                text,
            });
        }
    }
    scan
}

fn truncate_chars(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_owned();
    }
    let mut truncated: String = value.chars().take(max).collect();
    truncated.push('…');
    truncated
}

/// Path relative to `root`. When `root` *is* the file, its own name is the key.
fn relative_key(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .ok()
        .filter(|relative| !relative.as_os_str().is_empty())
        .map(|relative| {
            relative
                .components()
                .map(|component| component.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/")
        })
        .unwrap_or_else(|| {
            path.file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace() -> tempfile::TempDir {
        let temp = tempfile::tempdir().expect("temp dir");
        std::fs::write(
            temp.path().join("caller.rs"),
            "// authorize_call is described here\n\
             fn run() { authorize_call(); }\n\
             const DOC: &str = \"authorize_call\";\n",
        )
        .unwrap();
        std::fs::write(
            temp.path().join("other.rs"),
            "fn unrelated() { println!(\"nothing\"); }\n",
        )
        .unwrap();
        temp
    }

    #[test]
    fn reports_real_references_and_skips_comments_and_strings() {
        let temp = workspace();
        let scan = find_references(temp.path(), "authorize_call", &IndexLimits::default(), 50);
        assert_eq!(scan.references.len(), 1, "{:?}", scan.references);
        let reference = &scan.references[0];
        assert_eq!(reference.path, "caller.rs");
        assert_eq!(reference.line, 2);
        assert!(reference.text.contains("authorize_call()"));
        assert!(!scan.truncated);
    }

    #[test]
    fn scans_a_single_file_when_the_root_is_one() {
        let temp = workspace();
        let scan = find_references(
            &temp.path().join("caller.rs"),
            "authorize_call",
            &IndexLimits::default(),
            50,
        );
        assert_eq!(scan.files_scanned, 1);
        assert_eq!(scan.references[0].path, "caller.rs");
    }

    #[test]
    fn the_limit_truncates_and_says_so() {
        let temp = tempfile::tempdir().unwrap();
        let body = (0..30)
            .map(|index| format!("fn f{index}() {{ target(); }}"))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(temp.path().join("many.rs"), body).unwrap();

        let scan = find_references(temp.path(), "target", &IndexLimits::default(), 5);
        assert_eq!(scan.references.len(), 5);
        assert!(scan.truncated, "a capped scan must not look exhaustive");
    }

    #[test]
    fn an_absent_name_yields_nothing_without_error() {
        let temp = workspace();
        let scan = find_references(temp.path(), "no_such_symbol", &IndexLimits::default(), 50);
        assert!(scan.references.is_empty());
        assert!(!scan.truncated);
        assert_eq!(scan.files_scanned, 2);
    }

    #[test]
    fn long_lines_are_quoted_back_bounded() {
        let temp = tempfile::tempdir().unwrap();
        let padding = "x".repeat(MAX_LINE_CHARS * 2);
        std::fs::write(
            temp.path().join("wide.rs"),
            format!("fn f() {{ target(); /* {padding} */ }}\n"),
        )
        .unwrap();
        let scan = find_references(temp.path(), "target", &IndexLimits::default(), 50);
        assert_eq!(scan.references.len(), 1);
        assert!(scan.references[0].text.chars().count() <= MAX_LINE_CHARS + 1);
    }
}
