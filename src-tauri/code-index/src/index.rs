//! Workspace symbol index: build, cache, refresh, query.
//!
//! Built lazily on first use and refreshed incrementally against `mtime + size`
//! per file, because the alternative — reparsing the whole tree on every tool
//! call — makes the tools too slow to be worth calling.
//!
//! The cache is a pure derivative of the working tree, so it is always safe to
//! delete and never worth repairing: any version mismatch or parse failure
//! discards it and rebuilds.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use ignore::{WalkBuilder, WalkState};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::parser::{symbols_in_source, Language, Symbol, SymbolKind};

/// Bumped whenever the on-disk shape or the queries change in a way that makes
/// an existing cache wrong rather than merely stale.
const INDEX_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy)]
pub struct IndexLimits {
    /// Files above this are skipped. Bundles and generated sources are the
    /// usual offenders, and their symbols are never what the agent is after.
    pub max_file_bytes: u64,
    pub max_files: usize,
    pub max_symbols: usize,
}

impl Default for IndexLimits {
    fn default() -> Self {
        Self {
            max_file_bytes: 1024 * 1024,
            max_files: 20_000,
            max_symbols: 300_000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FileEntry {
    mtime_secs: u64,
    size: u64,
    language: Language,
    symbols: Vec<Symbol>,
}

#[derive(Debug, Serialize, Deserialize)]
struct IndexFile {
    version: u32,
    root: String,
    files: BTreeMap<String, FileEntry>,
}

/// What a refresh actually did. Surfaced to the model so a truncated index
/// never masquerades as a complete one.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RefreshStats {
    pub parsed: usize,
    pub reused: usize,
    pub removed: usize,
    pub skipped_large: usize,
    /// A limit stopped the walk: results are incomplete.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SymbolHit {
    /// Path relative to the indexed root, with `/` separators.
    pub path: String,
    pub symbol: Symbol,
}

/// How `find` matched. An exact hit and a salvaged fuzzy hit mean different
/// things to a caller deciding whether to trust the answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchMode {
    Exact,
    CaseInsensitiveSubstring,
}

pub struct CodeIndex {
    root: PathBuf,
    files: BTreeMap<String, FileEntry>,
}

impl CodeIndex {
    /// Load the cached index for `root`, or start empty.
    ///
    /// Any problem — missing, unreadable, wrong version, different root — is
    /// treated the same way: start over. The cache is never authoritative.
    pub fn load_or_empty(cache_dir: &Path, root: &Path) -> Self {
        let root = root.to_path_buf();
        let empty = Self {
            root: root.clone(),
            files: BTreeMap::new(),
        };
        let Ok(body) = std::fs::read(cache_path(cache_dir, &root)) else {
            return empty;
        };
        let Ok(cached) = serde_json::from_slice::<IndexFile>(&body) else {
            return empty;
        };
        if cached.version != INDEX_VERSION || cached.root != root.to_string_lossy() {
            return empty;
        }
        Self {
            root,
            files: cached.files,
        }
    }

    pub fn save(&self, cache_dir: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(cache_dir)?;
        let body = serde_json::to_vec(&IndexFile {
            version: INDEX_VERSION,
            root: self.root.to_string_lossy().into_owned(),
            files: self.files.clone(),
        })
        .map_err(std::io::Error::other)?;
        let path = cache_path(cache_dir, &self.root);
        // Write-then-rename so a crash cannot leave a half-written cache that
        // the next load has to detect.
        let temporary = path.with_extension("json.tmp");
        std::fs::write(&temporary, body)?;
        std::fs::rename(&temporary, &path)
    }

    /// Reparse what changed, drop what disappeared, keep the rest.
    pub fn refresh(&mut self, limits: &IndexLimits) -> RefreshStats {
        let collected = Mutex::new(Vec::<(String, FileEntry)>::new());
        let seen = Mutex::new(Vec::<String>::new());
        let stats = Mutex::new(RefreshStats::default());

        // `ignore`'s parallel walker gives us `.gitignore` handling and threads
        // without adding a dependency, and matches how os.fs.glob already
        // decides what is part of the workspace.
        WalkBuilder::new(&self.root)
            // Same filters os.fs.grep uses (tools/fs.rs). The two must agree on
            // what counts as part of the workspace, or the agent gets different
            // answers depending on which tool it happens to reach for.
            .follow_links(false)
            .standard_filters(true)
            .build_parallel()
            .run(|| {
                let collected = &collected;
                let seen = &seen;
                let stats = &stats;
                let existing = &self.files;
                let root = &self.root;
                Box::new(move |entry| {
                    let Ok(entry) = entry else {
                        return WalkState::Continue;
                    };
                    if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                        return WalkState::Continue;
                    }
                    let path = entry.path();
                    let Some(language) = Language::from_path(path) else {
                        return WalkState::Continue;
                    };
                    let Some(relative) = relative_key(root, path) else {
                        return WalkState::Continue;
                    };
                    let Ok(metadata) = entry.metadata() else {
                        return WalkState::Continue;
                    };
                    if metadata.len() > limits.max_file_bytes {
                        lock(stats).skipped_large += 1;
                        return WalkState::Continue;
                    }
                    let mtime_secs = metadata
                        .modified()
                        .ok()
                        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                        .map(|elapsed| elapsed.as_secs())
                        .unwrap_or_default();

                    lock(seen).push(relative.clone());

                    // Unchanged by mtime and size: keep the parsed symbols.
                    if let Some(previous) = existing.get(&relative) {
                        if previous.mtime_secs == mtime_secs && previous.size == metadata.len() {
                            lock(stats).reused += 1;
                            return WalkState::Continue;
                        }
                    }
                    let Ok(source) = std::fs::read_to_string(path) else {
                        return WalkState::Continue;
                    };
                    let Some(symbols) = symbols_in_source(language, &source) else {
                        return WalkState::Continue;
                    };
                    lock(stats).parsed += 1;
                    lock(collected).push((
                        relative,
                        FileEntry {
                            mtime_secs,
                            size: metadata.len(),
                            language,
                            symbols,
                        },
                    ));
                    WalkState::Continue
                })
            });

        let mut stats = stats
            .into_inner()
            .unwrap_or_else(|error| error.into_inner());
        let seen = seen.into_inner().unwrap_or_else(|error| error.into_inner());
        let collected = collected
            .into_inner()
            .unwrap_or_else(|error| error.into_inner());

        // Files that vanished since the last run.
        let live: std::collections::HashSet<&String> = seen.iter().collect();
        let before = self.files.len();
        self.files.retain(|key, _| live.contains(key));
        stats.removed = before - self.files.len();

        for (key, entry) in collected {
            self.files.insert(key, entry);
        }
        self.enforce_limits(limits, &mut stats);
        stats
    }

    /// Trim the index down to the configured ceilings.
    ///
    /// Dropping the tail of a sorted map is arbitrary, but any bound is, and
    /// `truncated` tells the caller not to read "no hits" as "not present".
    fn enforce_limits(&mut self, limits: &IndexLimits, stats: &mut RefreshStats) {
        if self.files.len() > limits.max_files {
            let keep: Vec<String> = self.files.keys().take(limits.max_files).cloned().collect();
            let keep: std::collections::HashSet<String> = keep.into_iter().collect();
            self.files.retain(|key, _| keep.contains(key));
            stats.truncated = true;
        }
        let mut total = 0usize;
        let mut over = Vec::new();
        for (key, entry) in &self.files {
            total += entry.symbols.len();
            if total > limits.max_symbols {
                over.push(key.clone());
            }
        }
        if !over.is_empty() {
            for key in over {
                self.files.remove(&key);
            }
            stats.truncated = true;
        }
    }

    /// Definitions named `name`.
    ///
    /// Exact match first. Only when that finds nothing does it fall back to a
    /// case-insensitive substring search, because a model working from memory
    /// often has the name almost right — and the returned [`MatchMode`] tells
    /// the caller which of the two answers it is looking at.
    pub fn find(
        &self,
        name: &str,
        kind: Option<SymbolKind>,
        limit: usize,
    ) -> (Vec<SymbolHit>, MatchMode) {
        let exact = self.collect(limit, |symbol| symbol.name == name, kind);
        if !exact.is_empty() {
            return (exact, MatchMode::Exact);
        }
        let needle = name.to_ascii_lowercase();
        let fuzzy = self.collect(
            limit,
            |symbol| symbol.name.to_ascii_lowercase().contains(&needle),
            kind,
        );
        (fuzzy, MatchMode::CaseInsensitiveSubstring)
    }

    fn collect(
        &self,
        limit: usize,
        matches: impl Fn(&Symbol) -> bool,
        kind: Option<SymbolKind>,
    ) -> Vec<SymbolHit> {
        let mut hits = Vec::new();
        for (path, entry) in &self.files {
            for symbol in &entry.symbols {
                if kind.is_some_and(|wanted| symbol.kind != wanted) || !matches(symbol) {
                    continue;
                }
                hits.push(SymbolHit {
                    path: path.clone(),
                    symbol: symbol.clone(),
                });
                if hits.len() >= limit {
                    return hits;
                }
            }
        }
        hits
    }

    /// Symbols declared in one file, in source order.
    pub fn symbols_in(&self, relative_path: &str) -> Option<&[Symbol]> {
        self.files
            .get(relative_path)
            .map(|entry| entry.symbols.as_slice())
    }

    pub fn file_count(&self) -> usize {
        self.files.len()
    }

    pub fn symbol_count(&self) -> usize {
        self.files.values().map(|entry| entry.symbols.len()).sum()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Stable, filesystem-safe cache file name for a root path.
fn cache_path(cache_dir: &Path, root: &Path) -> PathBuf {
    let digest = Sha256::digest(root.to_string_lossy().as_bytes());
    cache_dir.join(format!("{digest:x}.json"))
}

/// Path relative to the root, always `/`-separated so an index built on Windows
/// and read anywhere else agrees with itself.
fn relative_key(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    Some(
        relative
            .components()
            .map(|component| component.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace() -> tempfile::TempDir {
        let temp = tempfile::tempdir().expect("temp dir");
        std::fs::write(
            temp.path().join("lib.rs"),
            "pub fn authorize_call() {}\npub struct Registry;\n",
        )
        .unwrap();
        std::fs::create_dir_all(temp.path().join("web")).unwrap();
        std::fs::write(
            temp.path().join("web/app.ts"),
            "export const authorizeCall = () => {}\nexport interface Event {}\n",
        )
        .unwrap();
        std::fs::write(temp.path().join("README.md"), "# not code\n").unwrap();
        temp
    }

    #[test]
    fn indexes_multiple_languages_and_ignores_unknown_extensions() {
        let temp = workspace();
        let mut index = CodeIndex::load_or_empty(temp.path(), temp.path());
        let stats = index.refresh(&IndexLimits::default());

        assert_eq!(stats.parsed, 2, "one Rust and one TypeScript file");
        assert_eq!(index.file_count(), 2);
        assert!(index.symbols_in("README.md").is_none());
        assert!(index.symbols_in("web/app.ts").is_some());
    }

    #[test]
    fn respects_gitignore_like_the_rest_of_the_workspace_tools() {
        let temp = workspace();
        // `ignore` only applies .gitignore inside a repository, which is also
        // how os.fs.grep behaves. A real workspace is one.
        std::fs::create_dir_all(temp.path().join(".git")).unwrap();
        std::fs::write(temp.path().join(".gitignore"), "web/\n").unwrap();
        let mut index = CodeIndex::load_or_empty(temp.path(), temp.path());
        index.refresh(&IndexLimits::default());
        assert!(
            index.symbols_in("web/app.ts").is_none(),
            "ignored paths must stay out, as they do for os.fs.grep"
        );
        assert!(
            index.symbols_in("lib.rs").is_some(),
            "and everything else must stay in"
        );
    }

    #[test]
    fn finds_definitions_exactly_before_falling_back() {
        let temp = workspace();
        let mut index = CodeIndex::load_or_empty(temp.path(), temp.path());
        index.refresh(&IndexLimits::default());

        let (hits, mode) = index.find("authorize_call", None, 20);
        assert_eq!(mode, MatchMode::Exact);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "lib.rs");
        assert_eq!(hits[0].symbol.line, 1);

        // Nothing is named exactly this, but the intent is obvious.
        let (hits, mode) = index.find("AUTHORIZECALL", None, 20);
        assert_eq!(mode, MatchMode::CaseInsensitiveSubstring);
        assert!(hits.iter().any(|hit| hit.symbol.name == "authorizeCall"));

        let (hits, _) = index.find("Registry", Some(SymbolKind::Struct), 20);
        assert_eq!(hits.len(), 1);
        let (hits, _) = index.find("Registry", Some(SymbolKind::Class), 20);
        assert!(hits.is_empty(), "the kind filter must actually filter");
    }

    #[test]
    fn a_second_refresh_reuses_unchanged_files_and_reparses_edited_ones() {
        let temp = workspace();
        let mut index = CodeIndex::load_or_empty(temp.path(), temp.path());
        index.refresh(&IndexLimits::default());

        let stats = index.refresh(&IndexLimits::default());
        assert_eq!(stats.parsed, 0, "nothing changed, so nothing is reparsed");
        assert_eq!(stats.reused, 2);

        // Rewrite one file with a different size so the mtime granularity of
        // the filesystem cannot make this a false negative.
        std::fs::write(
            temp.path().join("lib.rs"),
            "pub fn authorize_call() {}\npub struct Registry;\npub fn added_later() {}\n",
        )
        .unwrap();
        let stats = index.refresh(&IndexLimits::default());
        assert_eq!(stats.parsed, 1);
        assert_eq!(stats.reused, 1);
        let (hits, _) = index.find("added_later", None, 5);
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn deleted_files_leave_the_index() {
        let temp = workspace();
        let mut index = CodeIndex::load_or_empty(temp.path(), temp.path());
        index.refresh(&IndexLimits::default());

        std::fs::remove_file(temp.path().join("web/app.ts")).unwrap();
        let stats = index.refresh(&IndexLimits::default());
        assert_eq!(stats.removed, 1);
        let (hits, _) = index.find("authorizeCall", None, 5);
        assert!(hits.is_empty(), "a deleted file must stop producing hits");
    }

    #[test]
    fn oversized_files_are_skipped_and_counted() {
        let temp = workspace();
        std::fs::write(
            temp.path().join("bundle.js"),
            format!("function huge() {{}}\n{}", "// pad\n".repeat(5_000)),
        )
        .unwrap();
        let mut index = CodeIndex::load_or_empty(temp.path(), temp.path());
        let stats = index.refresh(&IndexLimits {
            max_file_bytes: 1_000,
            ..IndexLimits::default()
        });
        assert_eq!(stats.skipped_large, 1);
        assert!(index.symbols_in("bundle.js").is_none());
    }

    #[test]
    fn the_cache_round_trips_and_is_discarded_when_stale() {
        let temp = workspace();
        let cache = tempfile::tempdir().unwrap();

        let mut index = CodeIndex::load_or_empty(cache.path(), temp.path());
        index.refresh(&IndexLimits::default());
        index.save(cache.path()).expect("save");

        let reloaded = CodeIndex::load_or_empty(cache.path(), temp.path());
        assert_eq!(reloaded.file_count(), 2);
        assert_eq!(reloaded.symbol_count(), index.symbol_count());

        // A cache written for a different root must not be adopted.
        let other = tempfile::tempdir().unwrap();
        assert_eq!(
            CodeIndex::load_or_empty(cache.path(), other.path()).file_count(),
            0
        );

        // Corruption is a rebuild, never an error.
        std::fs::write(cache_path(cache.path(), temp.path()), b"{ truncated").unwrap();
        assert_eq!(
            CodeIndex::load_or_empty(cache.path(), temp.path()).file_count(),
            0
        );
    }

    #[test]
    fn hitting_the_file_limit_is_reported_rather_than_hidden() {
        let temp = workspace();
        let mut index = CodeIndex::load_or_empty(temp.path(), temp.path());
        let stats = index.refresh(&IndexLimits {
            max_files: 1,
            ..IndexLimits::default()
        });
        assert!(stats.truncated, "a capped index must say so");
        assert_eq!(index.file_count(), 1);
    }
}
