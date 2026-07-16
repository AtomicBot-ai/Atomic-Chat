//! Static GBNF grammar for grammar-constrained tool calls.
//!
//! Ported from `grammars/tool-call.gbnf` in the TypeScript `atomic-agent`,
//! trimmed to the fixed iteration-1 tool set (see [`crate::core::agent::prompt::ITERATION_ONE_TOOLS`]).
//! No `browser` / `memory` / `tasks` / `skill` / `vision` / `mcp` branches — the
//! grammar is built statically under a known catalog, so the dynamic
//! rule-stitching / `removeBrowserToolRule` filtering from `build-grammar.ts`
//! is unnecessary.
//!
//! Root is **array-only** (`root ::= tool-call-array`): every completion starts
//! with `[` so the model cannot fall into the single-object form via
//! first-token bias even when it only needs one call. A solo step is the model
//! emitting `[{...}]`. Up to 16 calls per completion (the runtime also clamps
//! via `DEFAULT_MAX_PARALLEL_TOOL_CALLS`).

/// The complete GBNF grammar string sent to `llama-server` as the `grammar`
/// field of every `/completion` request that must produce a tool call.
///
/// The `tool-name` rule enumerates exactly the iteration-1 tools; the JSON
/// structural rules (`object` / `array` / `string` / `number` / ...) are
/// verbatim from the reference grammar.
pub const TOOL_CALL_GBNF: &str = r##"root ::= tool-call-array
tool-call ::= "{" ws "\"tool\"" ws ":" ws tool-name ws "," ws "\"args\"" ws ":" ws object ws "}"
tool-call-array ::= "[" ws tool-call ( ws "," ws tool-call ){0,15} ws "]"
tool-name ::= "\"tool.view\"" | os-tool | "\"reply\"" | "\"finish\""
os-tool ::= "\"os." ( "shell.run" | "fs.archive.read_entry" | "fs.archive.extract" | "fs.archive.list" | "fs.read_document" | "fs.read" | "fs.write" | "fs.trash" | "fs.list" | "fs.grep" | "fs.glob" | "fs.edit" | "fs.hash" | "fs.diff" | "fs.patch" | "http.request" | "web.search" | "web.fetch" | "git.status" | "git.log" | "git.diff" | "git.show" | "git.blame" | "git.branch" | "proc.list" | "proc.kill" | "clipboard.read" | "clipboard.write" | "notify" ) "\""

value ::= object | array | string | number | boolean | null-lit

object ::= "{" ws ( pair ( ws "," ws pair )* )? ws "}"
pair ::= string ws ":" ws value

array ::= "[" ws ( value ( ws "," ws value )* )? ws "]"

string ::= "\"" chars "\""
chars ::= char*
char ::= [^"\\\x00-\x1f] | "\\" escape
escape ::= "\"" | "\\" | "/" | "b" | "f" | "n" | "r" | "t" | "u" hex hex hex hex
hex ::= [0-9a-fA-F]

number ::= integer fraction? exponent?
integer ::= "-"? ( "0" | [1-9] [0-9]* )
fraction ::= "." [0-9]+
exponent ::= ("e" | "E") ("+" | "-")? [0-9]+

boolean ::= "true" | "false"
null-lit ::= "null"

ws ::= [ \t\n\r]*
"##;

/// The fixed set of tool names the grammar accepts, in the order they appear
/// in the `os-tool` alternation (plus the two terminals). Longer, more
/// specific names precede their prefixes (`fs.read_document` before `fs.read`,
/// `fs.archive.*` before `fs.*`) so the grammar alternation never shadows a
/// specific name with a shorter one that is a prefix of it.
///
/// This list must stay in sync with `ITERATION_ONE_TOOLS` in `prompt.rs`; the
/// `grammar_covers_every_iteration_one_tool` test enforces the invariant.
pub const GRAMMAR_TOOL_NAMES: &[&str] = &[
    "tool.view",
    "os.shell.run",
    "os.fs.archive.read_entry",
    "os.fs.archive.extract",
    "os.fs.archive.list",
    "os.fs.read_document",
    "os.fs.read",
    "os.fs.write",
    "os.fs.trash",
    "os.fs.list",
    "os.fs.grep",
    "os.fs.glob",
    "os.fs.edit",
    "os.fs.hash",
    "os.fs.diff",
    "os.fs.patch",
    "os.http.request",
    "os.web.search",
    "os.web.fetch",
    "os.git.status",
    "os.git.log",
    "os.git.diff",
    "os.git.show",
    "os.git.blame",
    "os.git.branch",
    "os.proc.list",
    "os.proc.kill",
    "os.clipboard.read",
    "os.clipboard.write",
    "os.notify",
    "reply",
    "finish",
];

/// Return the static tool-call grammar. A function (not just the const) so
/// future iterations can build it dynamically without touching call sites.
pub fn tool_call_grammar() -> &'static str {
    TOOL_CALL_GBNF
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::agent::prompt::ITERATION_ONE_TOOLS;

    #[test]
    fn root_is_array_only() {
        // The very first rule must bind `root` to the array form, never the
        // single-object form — this is the first-token-bias guard.
        let first_line = TOOL_CALL_GBNF.lines().next().expect("non-empty grammar");
        assert_eq!(first_line, "root ::= tool-call-array");
        assert!(TOOL_CALL_GBNF.contains("tool-call-array ::= \"[\""));
    }

    #[test]
    fn terminal_verbs_present() {
        assert!(TOOL_CALL_GBNF.contains(r#""\"reply\"""#));
        assert!(TOOL_CALL_GBNF.contains(r#""\"finish\"""#));
    }

    #[test]
    fn excluded_categories_absent() {
        // No deferred tool families leak into the iteration-1 grammar.
        for excluded in [
            "browser-tool",
            "memory-tool",
            "tasks-tool",
            "vision-tool",
            "discovery-tool",
            "mcp-native-tool",
            "mcp-server-tool",
            "skill.",
            "browser.",
            "memory.",
            "tasks.",
            "vision.describe",
            "mcp.",
        ] {
            assert!(
                !TOOL_CALL_GBNF.contains(excluded),
                "grammar must not contain deferred category `{excluded}`"
            );
        }
    }

    #[test]
    fn grammar_covers_every_iteration_one_tool() {
        // Every descriptor in the prompt catalog must be accepted by the
        // grammar, and every grammar name must map to a descriptor. This keeps
        // `prompt.rs` and `grammar.rs` from drifting apart.
        for descriptor in ITERATION_ONE_TOOLS {
            assert!(
                GRAMMAR_TOOL_NAMES.contains(&descriptor.name),
                "grammar is missing tool `{}` present in ITERATION_ONE_TOOLS",
                descriptor.name
            );
        }
        for name in GRAMMAR_TOOL_NAMES {
            assert!(
                ITERATION_ONE_TOOLS.iter().any(|d| &d.name == name),
                "grammar advertises `{name}` with no matching ITERATION_ONE_TOOLS descriptor"
            );
        }
        assert_eq!(GRAMMAR_TOOL_NAMES.len(), ITERATION_ONE_TOOLS.len());
    }

    #[test]
    fn every_os_tool_name_appears_in_the_os_rule() {
        // The `os-tool` alternation must literally contain each os.* suffix.
        for name in GRAMMAR_TOOL_NAMES {
            if let Some(suffix) = name.strip_prefix("os.") {
                assert!(
                    TOOL_CALL_GBNF.contains(&format!("\"{suffix}\"")),
                    "os-tool rule is missing `{suffix}`"
                );
            }
        }
    }

    #[test]
    fn more_specific_names_precede_their_prefixes() {
        // In a GBNF alternation the parser tries branches left-to-right; a
        // shorter prefix listed first would shadow the longer specific name.
        let idx = |needle: &str| TOOL_CALL_GBNF.find(needle).unwrap_or(usize::MAX);
        assert!(idx("\"fs.read_document\"") < idx("\"fs.read\""));
        assert!(idx("\"fs.archive.list\"") < idx("\"fs.list\""));
        assert!(idx("\"fs.archive.read_entry\"") < idx("\"fs.read\""));
    }

    #[test]
    fn json_structural_rules_present() {
        for rule in [
            "value ::=",
            "object ::=",
            "pair ::=",
            "array ::=",
            "string ::=",
            "number ::=",
            "boolean ::=",
            "null-lit ::=",
            "ws ::=",
        ] {
            assert!(
                TOOL_CALL_GBNF.contains(rule),
                "grammar missing structural rule `{rule}`"
            );
        }
    }
}
