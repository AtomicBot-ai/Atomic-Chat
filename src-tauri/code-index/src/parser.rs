//! Language detection and symbol extraction via tree-sitter queries.
//!
//! Scope is deliberately narrow: *definitions*, not a resolved semantic graph.
//! The question this answers is "where is `foo` declared", which a query over a
//! syntax tree answers exactly and cheaply. Anything requiring real name
//! resolution — which `foo` a call refers to across modules — is out of scope
//! and must not be implied by the results.

use std::path::Path;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use tree_sitter::{Parser, Query, QueryCursor, StreamingIterator};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Language {
    Rust,
    TypeScript,
    Tsx,
    JavaScript,
    Python,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SymbolKind {
    Class,
    Struct,
    Enum,
    Trait,
    Interface,
    Method,
    Function,
    Macro,
    Type,
    Module,
    Constant,
}

impl SymbolKind {
    fn from_capture(capture: &str) -> Option<Self> {
        match capture.strip_prefix("definition.")? {
            "class" => Some(Self::Class),
            "struct" => Some(Self::Struct),
            "enum" => Some(Self::Enum),
            "trait" => Some(Self::Trait),
            "interface" => Some(Self::Interface),
            "method" => Some(Self::Method),
            "function" => Some(Self::Function),
            "macro" => Some(Self::Macro),
            "type" => Some(Self::Type),
            "module" => Some(Self::Module),
            "constant" => Some(Self::Constant),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Class => "class",
            Self::Struct => "struct",
            Self::Enum => "enum",
            Self::Trait => "trait",
            Self::Interface => "interface",
            Self::Method => "method",
            Self::Function => "function",
            Self::Macro => "macro",
            Self::Type => "type",
            Self::Module => "module",
            Self::Constant => "constant",
        }
    }

    /// Parse a caller-supplied `kind` filter.
    pub fn parse(value: &str) -> Option<Self> {
        let normalized = value.trim().to_ascii_lowercase();
        [
            Self::Class,
            Self::Struct,
            Self::Enum,
            Self::Trait,
            Self::Interface,
            Self::Method,
            Self::Function,
            Self::Macro,
            Self::Type,
            Self::Module,
            Self::Constant,
        ]
        .into_iter()
        .find(|kind| kind.as_str() == normalized)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Symbol {
    pub name: String,
    pub kind: SymbolKind,
    /// 1-based, to match how every editor and every other tool here reports it.
    pub line: u32,
}

struct LanguageSupport {
    language: tree_sitter::Language,
    query: Query,
}

impl Language {
    pub fn from_path(path: &Path) -> Option<Self> {
        match path.extension()?.to_str()? {
            "rs" => Some(Self::Rust),
            "ts" | "mts" | "cts" => Some(Self::TypeScript),
            "tsx" => Some(Self::Tsx),
            "js" | "mjs" | "cjs" | "jsx" => Some(Self::JavaScript),
            "py" | "pyi" => Some(Self::Python),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Rust => "rust",
            Self::TypeScript => "typescript",
            Self::Tsx => "tsx",
            Self::JavaScript => "javascript",
            Self::Python => "python",
        }
    }

    fn grammar(self) -> tree_sitter::Language {
        match self {
            Self::Rust => tree_sitter_rust::LANGUAGE.into(),
            Self::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Self::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Self::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
            Self::Python => tree_sitter_python::LANGUAGE.into(),
        }
    }

    fn query_source(self) -> &'static str {
        match self {
            Self::Rust => include_str!("queries/rust.scm"),
            Self::TypeScript | Self::Tsx => include_str!("queries/typescript.scm"),
            Self::JavaScript => include_str!("queries/javascript.scm"),
            Self::Python => include_str!("queries/python.scm"),
        }
    }

    /// Compiled grammar and query, built once per language per process.
    ///
    /// Compiling a `Query` is not free, and the index parses thousands of files
    /// in a row; doing it per file dominated the walk in early measurement.
    fn support(self) -> &'static LanguageSupport {
        macro_rules! cached {
            ($slot:ident) => {{
                static $slot: OnceLock<LanguageSupport> = OnceLock::new();
                $slot.get_or_init(|| {
                    let language = self.grammar();
                    let query =
                        Query::new(&language, self.query_source()).unwrap_or_else(|error| {
                            // The queries are compiled into the binary, so a failure
                            // here is a bug in this crate, not bad input. The unit
                            // tests below catch it before it can ship.
                            panic!("built-in {} query is invalid: {error}", self.as_str())
                        });
                    LanguageSupport { language, query }
                })
            }};
        }
        match self {
            Self::Rust => cached!(RUST),
            Self::TypeScript => cached!(TYPESCRIPT),
            Self::Tsx => cached!(TSX),
            Self::JavaScript => cached!(JAVASCRIPT),
            Self::Python => cached!(PYTHON),
        }
    }
}

/// Extract every definition the language's query matches.
///
/// Returns `None` when the source cannot be parsed at all. tree-sitter is
/// error-tolerant, so a file mid-edit still yields the symbols it *can* see —
/// which is what a coding agent wants.
pub fn symbols_in_source(language: Language, source: &str) -> Option<Vec<Symbol>> {
    let support = language.support();
    let mut parser = Parser::new();
    parser.set_language(&support.language).ok()?;
    let tree = parser.parse(source, None)?;

    let capture_names = support.query.capture_names();
    let mut symbols = Vec::new();
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(&support.query, tree.root_node(), source.as_bytes());
    while let Some(matched) = matches.next() {
        for capture in matched.captures {
            let Some(kind) = SymbolKind::from_capture(capture_names[capture.index as usize]) else {
                continue;
            };
            let Ok(name) = capture.node.utf8_text(source.as_bytes()) else {
                continue;
            };
            symbols.push(Symbol {
                name: name.to_owned(),
                kind,
                line: capture.node.start_position().row as u32 + 1,
            });
        }
    }
    Some(dedupe_symbols(symbols))
}

/// Collapse captures that landed on the same identifier.
///
/// Some patterns deliberately overlap — `const Foo = () => {}` matches both the
/// arrow-function rule and the general constant rule — because writing a single
/// mutually-exclusive pattern per kind makes the queries far harder to read.
/// `SymbolKind`'s declaration order is the tiebreak, most specific first.
fn dedupe_symbols(mut symbols: Vec<Symbol>) -> Vec<Symbol> {
    symbols.sort_by(|left, right| {
        left.line
            .cmp(&right.line)
            .then_with(|| left.name.cmp(&right.name))
            .then_with(|| left.kind.cmp(&right.kind))
    });
    symbols.dedup_by(|later, kept| later.line == kept.line && later.name == kept.name);
    symbols
}

/// Lines (1-based) where `name` appears as an identifier.
///
/// Syntax-aware on purpose: a plain text search also matches the name inside
/// comments and string literals, which is most of the noise in a grep result.
/// This is *not* name resolution — a same-named symbol from an unrelated module
/// is indistinguishable here, and callers must say so.
pub fn identifier_occurrences(language: Language, source: &str, name: &str) -> Option<Vec<u32>> {
    let support = language.support();
    let mut parser = Parser::new();
    parser.set_language(&support.language).ok()?;
    let tree = parser.parse(source, None)?;

    let bytes = source.as_bytes();
    let mut lines = Vec::new();
    let mut stack = vec![tree.root_node()];
    while let Some(node) = stack.pop() {
        if node.child_count() > 0 {
            for index in 0..node.child_count() {
                if let Some(child) = node.child(index) {
                    stack.push(child);
                }
            }
            continue;
        }
        // Leaf node. Comments and string bodies carry the name as prose, not as
        // a reference, and they are the bulk of what makes grep noisy.
        let kind = node.kind();
        if kind.contains("comment") || kind.contains("string") {
            continue;
        }
        if node.utf8_text(bytes) == Ok(name) {
            lines.push(node.start_position().row as u32 + 1);
        }
    }
    lines.sort_unstable();
    lines.dedup();
    Some(lines)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds_of(language: Language, source: &str, name: &str) -> Vec<SymbolKind> {
        symbols_in_source(language, source)
            .expect("parses")
            .into_iter()
            .filter(|symbol| symbol.name == name)
            .map(|symbol| symbol.kind)
            .collect()
    }

    #[test]
    fn every_built_in_query_compiles() {
        // `support()` panics on an invalid query; touching each language here
        // turns "the agent's code tools are broken at runtime" into a test
        // failure at build time.
        for language in [
            Language::Rust,
            Language::TypeScript,
            Language::Tsx,
            Language::JavaScript,
            Language::Python,
        ] {
            assert!(!language.support().query.capture_names().is_empty());
        }
    }

    #[test]
    fn detects_languages_by_extension() {
        assert_eq!(
            Language::from_path(Path::new("a/b.rs")),
            Some(Language::Rust)
        );
        assert_eq!(Language::from_path(Path::new("a.tsx")), Some(Language::Tsx));
        assert_eq!(
            Language::from_path(Path::new("a.mts")),
            Some(Language::TypeScript)
        );
        assert_eq!(
            Language::from_path(Path::new("a.jsx")),
            Some(Language::JavaScript)
        );
        assert_eq!(
            Language::from_path(Path::new("a.py")),
            Some(Language::Python)
        );
        assert_eq!(Language::from_path(Path::new("README.md")), None);
        assert_eq!(Language::from_path(Path::new("Makefile")), None);
    }

    #[test]
    fn extracts_rust_definitions_with_positions() {
        let source = "\
pub struct Registry;

pub trait Store {}

pub enum Mode { On, Off }

pub const LIMIT: usize = 4;

impl Registry {
    pub fn spawn(&self) {}
}

pub fn free_standing() {}
";
        let symbols = symbols_in_source(Language::Rust, source).expect("parses");
        let found = |name: &str| symbols.iter().find(|symbol| symbol.name == name).cloned();

        assert_eq!(found("Registry").unwrap().kind, SymbolKind::Struct);
        assert_eq!(found("Registry").unwrap().line, 1);
        assert_eq!(found("Store").unwrap().kind, SymbolKind::Trait);
        assert_eq!(found("Mode").unwrap().kind, SymbolKind::Enum);
        assert_eq!(found("LIMIT").unwrap().kind, SymbolKind::Constant);
        // Methods inside an `impl` are still `function_item` nodes; the point
        // is that they are found at all, and at the right line.
        assert_eq!(found("spawn").unwrap().line, 10);
        assert_eq!(found("free_standing").unwrap().kind, SymbolKind::Function);
    }

    #[test]
    fn arrow_function_constants_are_reported_as_functions() {
        // The dominant declaration form in this repo's frontend. Reporting it
        // as a plain constant would bury it.
        let source = "export const useAgentRun = (id: string) => ({ id })\n";
        assert_eq!(
            kinds_of(Language::TypeScript, source, "useAgentRun"),
            vec![SymbolKind::Function]
        );

        let plain = "const LIMIT = 4\n";
        assert_eq!(
            kinds_of(Language::TypeScript, plain, "LIMIT"),
            vec![SymbolKind::Constant]
        );
    }

    #[test]
    fn extracts_typescript_types_classes_and_methods() {
        let source = "\
export interface AgentEvent { type: string }
export type Status = 'ok' | 'error'
export enum Level { Warn }
export class Runner {
  start(): void {}
}
export function build() {}
";
        let symbols = symbols_in_source(Language::TypeScript, source).expect("parses");
        let kind = |name: &str| {
            symbols
                .iter()
                .find(|symbol| symbol.name == name)
                .map(|symbol| symbol.kind)
        };
        assert_eq!(kind("AgentEvent"), Some(SymbolKind::Interface));
        assert_eq!(kind("Status"), Some(SymbolKind::Type));
        assert_eq!(kind("Level"), Some(SymbolKind::Enum));
        assert_eq!(kind("Runner"), Some(SymbolKind::Class));
        assert_eq!(kind("start"), Some(SymbolKind::Method));
        assert_eq!(kind("build"), Some(SymbolKind::Function));
    }

    #[test]
    fn parses_tsx_components() {
        let source = "\
export const Chat = ({ id }: { id: string }) => <div>{id}</div>
export function Panel() { return <span /> }
";
        let symbols = symbols_in_source(Language::Tsx, source).expect("parses");
        let names = symbols
            .iter()
            .map(|symbol| symbol.name.as_str())
            .collect::<Vec<_>>();
        assert!(names.contains(&"Chat"), "{names:?}");
        assert!(names.contains(&"Panel"), "{names:?}");
    }

    #[test]
    fn extracts_python_definitions_including_decorated_ones() {
        let source = "\
class Runner:
    def start(self):
        pass

@cache
def build():
    pass
";
        let symbols = symbols_in_source(Language::Python, source).expect("parses");
        let kind = |name: &str| {
            symbols
                .iter()
                .find(|symbol| symbol.name == name)
                .map(|symbol| symbol.kind)
        };
        assert_eq!(kind("Runner"), Some(SymbolKind::Class));
        assert_eq!(kind("start"), Some(SymbolKind::Function));
        assert_eq!(kind("build"), Some(SymbolKind::Function));
    }

    #[test]
    fn a_file_with_syntax_errors_still_yields_what_it_can() {
        // Files are read mid-edit all the time; returning nothing would make
        // the tool useless exactly when the agent is working on a file.
        let source = "pub fn good() {}\npub fn broken( {\n";
        let symbols = symbols_in_source(Language::Rust, source).expect("tolerates errors");
        assert!(symbols.iter().any(|symbol| symbol.name == "good"));
    }

    #[test]
    fn occurrences_ignore_comments_and_string_literals() {
        let source = "\
// mentions target in a comment
let label = \"target\";
fn use_it() { target(); }
";
        let lines = identifier_occurrences(Language::Rust, source, "target").expect("parses");
        // Only the call on line 3 is a real reference.
        assert_eq!(lines, vec![3]);
    }

    #[test]
    fn occurrences_report_every_distinct_line_once() {
        let source = "fn a() { x(); x(); }\nfn b() { x(); }\n";
        let lines = identifier_occurrences(Language::Rust, source, "x").expect("parses");
        assert_eq!(lines, vec![1, 2]);
    }

    #[test]
    fn kind_filter_round_trips() {
        for kind in [
            SymbolKind::Class,
            SymbolKind::Function,
            SymbolKind::Constant,
        ] {
            assert_eq!(SymbolKind::parse(kind.as_str()), Some(kind));
        }
        assert_eq!(SymbolKind::parse("  FUNCTION "), Some(SymbolKind::Function));
        assert_eq!(SymbolKind::parse("widget"), None);
    }
}
