//! Schema-specific GBNF grammar for grammar-constrained tool calls.
//!
//! Ported from `grammars/tool-call.gbnf` in the TypeScript `atomic-agent`,
//! trimmed to the fixed iteration-1 tool set (see [`crate::core::agent::prompt::ITERATION_ONE_TOOLS`]).
//! No `browser` / `memory` / `tasks` / `mcp` branches — the
//! core catalog is static, while enabled skill names are stitched into the
//! grammar for each turn.
//!
//! Root is **array-only** (`root ::= tool-call-array`): every completion starts
//! with `[` so the model cannot fall into the single-object form via
//! first-token bias even when it only needs one call. A solo step is the model
//! emitting `[{...}]`. Up to 16 calls per completion (the runtime also clamps
//! via `DEFAULT_MAX_PARALLEL_TOOL_CALLS`).

use std::fmt::Write;

use super::{
    model_profile::AgentModelProfile,
    prompt::{ToolTier, ITERATION_ONE_TOOLS},
    skills::SkillRegistry,
};

struct ToolGrammar {
    name: &'static str,
    rule: &'static str,
    args: &'static str,
}

const STATIC_TOOL_GRAMMARS: &[ToolGrammar] = &[
    ToolGrammar {
        name: "tool.view",
        rule: "tool-view",
        args: r#""{" ws "\"name\"" ws ":" ws rare-tool-name ws "}""#,
    },
    ToolGrammar {
        name: "os.shell.run",
        rule: "shell-run",
        args: r#""{" ws "\"cmd\"" ws ":" ws non-empty-string ( ws "," ws "\"args\"" ws ":" ws string-array )? ( ws "," ws "\"cwd\"" ws ":" ws non-empty-string )? ( ws "," ws "\"timeoutMs\"" ws ":" ws positive-integer )? ws "}""#,
    },
    ToolGrammar {
        name: "os.fs.archive.read_entry",
        rule: "fs-archive-read-entry",
        args: r#""{" ws "\"path\"" ws ":" ws non-empty-string ws "," ws "\"entry\"" ws ":" ws non-empty-string ws "}""#,
    },
    ToolGrammar {
        name: "os.fs.archive.extract",
        rule: "fs-archive-extract",
        args: r#""{" ws "\"path\"" ws ":" ws non-empty-string ws "," ws "\"destination\"" ws ":" ws non-empty-string ( ws "," ws "\"overwrite\"" ws ":" ws boolean )? ws "}""#,
    },
    ToolGrammar {
        name: "os.fs.archive.list",
        rule: "fs-archive-list",
        args: r#""{" ws "\"path\"" ws ":" ws non-empty-string ws "}""#,
    },
    ToolGrammar {
        name: "os.fs.read_document",
        rule: "fs-read-document",
        args: r#""{" ws "\"path\"" ws ":" ws non-empty-string ( ws "," ws "\"maxChars\"" ws ":" ws positive-integer )? ws "}""#,
    },
    ToolGrammar {
        name: "os.fs.read",
        rule: "fs-read",
        args: r#""{" ws "\"path\"" ws ":" ws non-empty-string ( ws "," ws "\"offset\"" ws ":" ws nonnegative-integer )? ( ws "," ws "\"limit\"" ws ":" ws positive-integer )? ws "}""#,
    },
    ToolGrammar {
        name: "os.fs.write",
        rule: "fs-write",
        args: r#""{" ws "\"path\"" ws ":" ws non-empty-string ws "," ws "\"content\"" ws ":" ws string ( ws "," ws "\"mode\"" ws ":" ws ( "\"replace\"" | "\"append\"" ) )? ws "}""#,
    },
    ToolGrammar {
        name: "os.fs.mkdir",
        rule: "fs-mkdir",
        args: r#""{" ws "\"path\"" ws ":" ws non-empty-string ( ws "," ws "\"recursive\"" ws ":" ws boolean )? ws "}""#,
    },
    ToolGrammar {
        name: "os.fs.trash",
        rule: "fs-trash",
        args: r#""{" ws "\"paths\"" ws ":" ws non-empty-string-array ws "}""#,
    },
    ToolGrammar {
        name: "os.fs.list",
        rule: "fs-list",
        args: r#""{" ws ( "\"path\"" ws ":" ws non-empty-string )? ws "}""#,
    },
    ToolGrammar {
        name: "os.fs.grep",
        rule: "fs-grep",
        args: r#""{" ws "\"pattern\"" ws ":" ws non-empty-string ( ws "," ws "\"path\"" ws ":" ws non-empty-string )? ws "}""#,
    },
    ToolGrammar {
        name: "os.fs.glob",
        rule: "fs-glob",
        args: r#""{" ws "\"pattern\"" ws ":" ws non-empty-string ( ws "," ws "\"cwd\"" ws ":" ws non-empty-string )? ws "}""#,
    },
    ToolGrammar {
        name: "os.fs.edit",
        rule: "fs-edit",
        args: r#""{" ws "\"path\"" ws ":" ws non-empty-string ws "," ws "\"oldString\"" ws ":" ws non-empty-string ws "," ws "\"newString\"" ws ":" ws string ( ws "," ws "\"replaceAll\"" ws ":" ws boolean )? ws "}""#,
    },
    ToolGrammar {
        name: "os.fs.hash",
        rule: "fs-hash",
        args: r#""{" ws "\"path\"" ws ":" ws non-empty-string ( ws "," ws "\"algorithm\"" ws ":" ws ( "\"md5\"" | "\"sha1\"" | "\"sha256\"" | "\"sha512\"" ) )? ws "}""#,
    },
    ToolGrammar {
        name: "os.fs.diff",
        rule: "fs-diff",
        args: r#""{" ws "\"pathA\"" ws ":" ws non-empty-string ws "," ws "\"pathB\"" ws ":" ws non-empty-string ws "}""#,
    },
    ToolGrammar {
        name: "os.fs.patch",
        rule: "fs-patch",
        args: r#""{" ws "\"patch\"" ws ":" ws non-empty-string ( ws "," ws "\"apply\"" ws ":" ws boolean )? ws "}""#,
    },
    ToolGrammar {
        name: "os.http.request",
        rule: "http-request",
        args: r#""{" ws "\"url\"" ws ":" ws non-empty-string ( ws "," ws "\"method\"" ws ":" ws non-empty-string )? ( ws "," ws "\"headers\"" ws ":" ws string-map )? ( ws "," ws "\"body\"" ws ":" ws string )? ( ws "," ws "\"timeoutMs\"" ws ":" ws positive-integer )? ws "}""#,
    },
    ToolGrammar {
        name: "os.web.search",
        rule: "web-search",
        args: r#""{" ws "\"query\"" ws ":" ws non-empty-string ( ws "," ws "\"maxResults\"" ws ":" ws positive-integer )? ws "}""#,
    },
    ToolGrammar {
        name: "os.web.fetch",
        rule: "web-fetch",
        args: r#""{" ws "\"url\"" ws ":" ws non-empty-string ( ws "," ws "\"extractMode\"" ws ":" ws ( "\"markdown\"" | "\"text\"" ) )? ( ws "," ws "\"maxChars\"" ws ":" ws positive-integer )? ws "}""#,
    },
    ToolGrammar {
        name: "vision.describe",
        rule: "vision-describe",
        args: r#""{" ws "\"paths\"" ws ":" ws non-empty-string-array ws "," ws "\"prompt\"" ws ":" ws non-empty-string ws "}""#,
    },
    ToolGrammar {
        name: "os.git.status",
        rule: "git-status",
        args: r#""{" ws ( "\"cwd\"" ws ":" ws non-empty-string )? ws "}""#,
    },
    ToolGrammar {
        name: "os.git.log",
        rule: "git-log",
        args: r#""{" ws ( "\"cwd\"" ws ":" ws non-empty-string ( ws "," ws "\"maxCount\"" ws ":" ws positive-integer )? ( ws "," ws "\"path\"" ws ":" ws non-empty-string )? | "\"maxCount\"" ws ":" ws positive-integer ( ws "," ws "\"path\"" ws ":" ws non-empty-string )? | "\"path\"" ws ":" ws non-empty-string )? ws "}""#,
    },
    ToolGrammar {
        name: "os.git.diff",
        rule: "git-diff",
        args: r#""{" ws ( "\"cwd\"" ws ":" ws non-empty-string ( ws "," ws "\"staged\"" ws ":" ws boolean )? ( ws "," ws "\"revision\"" ws ":" ws non-empty-string )? ( ws "," ws "\"path\"" ws ":" ws non-empty-string )? | "\"staged\"" ws ":" ws boolean ( ws "," ws "\"revision\"" ws ":" ws non-empty-string )? ( ws "," ws "\"path\"" ws ":" ws non-empty-string )? | "\"revision\"" ws ":" ws non-empty-string ( ws "," ws "\"path\"" ws ":" ws non-empty-string )? | "\"path\"" ws ":" ws non-empty-string )? ws "}""#,
    },
    ToolGrammar {
        name: "os.git.show",
        rule: "git-show",
        args: r#""{" ws ( "\"cwd\"" ws ":" ws non-empty-string ws "," ws )? "\"revision\"" ws ":" ws non-empty-string ws "}""#,
    },
    ToolGrammar {
        name: "os.git.blame",
        rule: "git-blame",
        args: r#""{" ws ( "\"cwd\"" ws ":" ws non-empty-string ws "," ws )? "\"path\"" ws ":" ws non-empty-string ws "}""#,
    },
    ToolGrammar {
        name: "os.git.branch",
        rule: "git-branch",
        args: r#""{" ws ( "\"cwd\"" ws ":" ws non-empty-string )? ws "}""#,
    },
    ToolGrammar {
        name: "os.proc.list",
        rule: "proc-list",
        args: r#""{" ws ( "\"filter\"" ws ":" ws non-empty-string ( ws "," ws "\"maxEntries\"" ws ":" ws positive-integer )? | "\"maxEntries\"" ws ":" ws positive-integer )? ws "}""#,
    },
    ToolGrammar {
        name: "os.proc.kill",
        rule: "proc-kill",
        args: r#""{" ws "\"pid\"" ws ":" ws positive-integer ( ws "," ws "\"signal\"" ws ":" ws ( "\"SIGTERM\"" | "\"SIGKILL\"" | "\"SIGINT\"" | "\"SIGHUP\"" ) )? ws "}""#,
    },
    ToolGrammar {
        name: "os.clipboard.read",
        rule: "clipboard-read",
        args: r#""{" ws "}""#,
    },
    ToolGrammar {
        name: "os.clipboard.write",
        rule: "clipboard-write",
        args: r#""{" ws "\"text\"" ws ":" ws string ws "}""#,
    },
    ToolGrammar {
        name: "os.notify",
        rule: "notify",
        args: r#""{" ws "\"title\"" ws ":" ws non-empty-string ( ws "," ws "\"body\"" ws ":" ws string )? ws "}""#,
    },
    ToolGrammar {
        name: "reply",
        rule: "reply",
        args: r#""{" ws "\"text\"" ws ":" ws non-empty-string ws "}""#,
    },
    ToolGrammar {
        name: "finish",
        rule: "finish",
        args: r#""{" ws "\"summary\"" ws ":" ws non-empty-string ws "}""#,
    },
];

const JSON_RULES: &str = r##"tool-call-array ::= "[" ws tool-call ( ws "," ws tool-call ){0,15} ws "]"
call-prefix ::= "{" ws "\"tool\"" ws ":" ws
args-prefix ::= ws "," ws "\"args\"" ws ":" ws
call-suffix ::= ws "}"

string-map ::= "{" ws ( string ws ":" ws string ( ws "," ws string ws ":" ws string )* )? ws "}"
string-array ::= "[" ws ( string ( ws "," ws string )* )? ws "]"
non-empty-string-array ::= "[" ws non-empty-string ( ws "," ws non-empty-string )* ws "]"

string ::= "\"" chars "\""
non-empty-string ::= "\"" char+ "\""
chars ::= char*
char ::= [^"\\\x00-\x1f] | "\\" escape
escape ::= "\"" | "\\" | "/" | "b" | "f" | "n" | "r" | "t" | "u" hex hex hex hex
hex ::= [0-9a-fA-F]

nonnegative-integer ::= "0" | [1-9] [0-9]*
positive-integer ::= [1-9] [0-9]*
boolean ::= "true" | "false"
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
    "skill.view",
    "skill.run_script",
    "os.shell.run",
    "os.fs.archive.read_entry",
    "os.fs.archive.extract",
    "os.fs.archive.list",
    "os.fs.read_document",
    "os.fs.read",
    "os.fs.write",
    "os.fs.mkdir",
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
    "vision.describe",
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

/// Build the tool-call grammar from the fixed tool catalog and the enabled,
/// compatible skill registry visible to this turn.
pub fn tool_call_grammar(skill_registry: &SkillRegistry) -> String {
    tool_call_grammar_for_profile(skill_registry, AgentModelProfile::Plain)
}

pub fn tool_call_grammar_for_profile(
    skill_registry: &SkillRegistry,
    profile: AgentModelProfile,
) -> String {
    let skill_names = skill_registry
        .enabled()
        .map(|record| record.manifest.name.as_str())
        .collect::<Vec<_>>();
    let mut call_rules = STATIC_TOOL_GRAMMARS
        .iter()
        .map(|grammar| format!("{}-call", grammar.rule))
        .collect::<Vec<_>>();
    if !skill_names.is_empty() {
        call_rules.insert(1, "skill-view-call".into());
        call_rules.insert(2, "skill-run-script-call".into());
    }

    let root = if profile == AgentModelProfile::Gemma4Think {
        "channel-prelude tool-call-array"
    } else {
        "tool-call-array"
    };
    let mut grammar = format!(
        "root ::= {root}\ntool-call ::= {}\n",
        call_rules.join(" | ")
    );
    for tool in STATIC_TOOL_GRAMMARS {
        writeln!(
            grammar,
            "{}-call ::= call-prefix {} args-prefix {}-args call-suffix",
            tool.rule,
            gbnf_json_literal(tool.name),
            tool.rule
        )
        .expect("writing tool grammar to String cannot fail");
        writeln!(grammar, "{}-args ::= {}", tool.rule, tool.args)
            .expect("writing tool args grammar to String cannot fail");
    }

    if !skill_names.is_empty() {
        grammar.push_str(
            "skill-view-call ::= call-prefix \"\\\"skill.view\\\"\" args-prefix skill-view-args call-suffix\n\
             skill-view-args ::= \"{\" ws \"\\\"name\\\"\" ws \":\" ws skill-name ws \"}\"\n\
             skill-run-script-call ::= call-prefix \"\\\"skill.run_script\\\"\" args-prefix skill-run-script-args call-suffix\n\
             skill-run-script-args ::= \"{\" ws \"\\\"skill\\\"\" ws \":\" ws skill-name ws \",\" ws \"\\\"script\\\"\" ws \":\" ws non-empty-string ( ws \",\" ws \"\\\"args\\\"\" ws \":\" ws string-array )? ( ws \",\" ws \"\\\"timeout_ms\\\"\" ws \":\" ws positive-integer )? ws \"}\"\n",
        );
        writeln!(
            grammar,
            "skill-name ::= {}",
            skill_names
                .iter()
                .map(|name| gbnf_json_literal(name))
                .collect::<Vec<_>>()
                .join(" | ")
        )
        .expect("writing skill grammar to String cannot fail");
    }

    let rare_tool_names = ITERATION_ONE_TOOLS
        .iter()
        .filter(|descriptor| descriptor.tier == ToolTier::Rare)
        .map(|descriptor| gbnf_json_literal(descriptor.name))
        .collect::<Vec<_>>();
    writeln!(
        grammar,
        "rare-tool-name ::= {}",
        rare_tool_names.join(" | ")
    )
    .expect("writing rare tool grammar to String cannot fail");
    grammar.push_str(JSON_RULES);
    if let (Some(open), Some(close)) = (profile.reasoning_open_tag(), profile.reasoning_close_tag())
    {
        write_reasoning_prelude(&mut grammar, "channel", open, close);
    }
    grammar
}

fn write_reasoning_prelude(grammar: &mut String, stem: &str, open: &str, close: &str) {
    let mut fragments = vec![format!(
        "[^{}]+",
        escape_char_class(close.as_bytes()[0] as char)
    )];
    for index in 0..close.len() - 1 {
        let prefix = &close[..=index];
        let next = close.as_bytes()[index + 1] as char;
        fragments.push(format!(
            "{} [^{}]",
            gbnf_string_literal(prefix),
            escape_char_class(next)
        ));
    }
    writeln!(
        grammar,
        "{stem}-prelude ::= {} {stem}-body {} prelude-trail-ws",
        gbnf_string_literal(open),
        gbnf_string_literal(close)
    )
    .expect("writing reasoning grammar to String cannot fail");
    writeln!(grammar, "{stem}-body ::= {stem}-fragment*")
        .expect("writing reasoning grammar to String cannot fail");
    writeln!(grammar, "{stem}-fragment ::= {}", fragments.join(" | "))
        .expect("writing reasoning grammar to String cannot fail");
    grammar.push_str("prelude-trail-ws ::= ( [ \\t\\n\\r] ){0,8}\n");
}

fn gbnf_string_literal(value: &str) -> String {
    let terminal = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r");
    format!("\"{terminal}\"")
}

fn escape_char_class(value: char) -> String {
    match value {
        '\\' | ']' | '^' | '-' => format!("\\{value}"),
        value => value.to_string(),
    }
}

fn gbnf_json_literal(value: &str) -> String {
    let json = serde_json::to_string(value).expect("serializing a string cannot fail");
    let terminal = json.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{terminal}\"")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::BTreeSet, fs};

    use tempfile::TempDir;

    fn grammar_with_skills(names: &[&str]) -> String {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("skills");
        fs::create_dir_all(&root).unwrap();
        for name in names {
            let skill = root.join(name);
            fs::create_dir_all(&skill).unwrap();
            fs::write(
                skill.join("SKILL.md"),
                format!("---\nname: {name}\ndescription: Test\n---\nBody"),
            )
            .unwrap();
        }
        let registry = SkillRegistry::load(&root, &BTreeSet::new(), &BTreeSet::new()).unwrap();
        tool_call_grammar(&registry)
    }

    #[test]
    fn gemma4_grammar_requires_model_emitted_channel_prelude() {
        let temp = TempDir::new().unwrap();
        let root = temp.path().join("skills");
        fs::create_dir_all(&root).unwrap();
        let registry = SkillRegistry::load(&root, &BTreeSet::new(), &BTreeSet::new()).unwrap();
        let grammar = tool_call_grammar_for_profile(&registry, AgentModelProfile::Gemma4Think);

        assert!(grammar.starts_with("root ::= channel-prelude tool-call-array\n"));
        assert!(grammar.contains(
            "channel-prelude ::= \"<|channel>thought\\n\" channel-body \"<channel|>\" prelude-trail-ws"
        ));
        assert!(grammar.contains("prelude-trail-ws ::= ( [ \\t\\n\\r] ){0,8}"));
    }

    #[test]
    fn root_is_array_only() {
        // The very first rule must bind `root` to the array form, never the
        // single-object form — this is the first-token-bias guard.
        let grammar = grammar_with_skills(&[]);
        let first_line = grammar.lines().next().expect("non-empty grammar");
        assert_eq!(first_line, "root ::= tool-call-array");
        assert!(grammar.contains("tool-call-array ::= \"[\""));
    }

    #[test]
    fn terminal_verbs_present() {
        let grammar = grammar_with_skills(&[]);
        assert!(grammar.contains(r#""\"reply\"""#));
        assert!(grammar.contains(r#""\"finish\"""#));
    }

    #[test]
    fn excluded_categories_absent() {
        let grammar = grammar_with_skills(&[]);
        // No deferred tool families leak into the iteration-1 grammar.
        for excluded in [
            "browser-tool",
            "memory-tool",
            "tasks-tool",
            "discovery-tool",
            "mcp-native-tool",
            "mcp-server-tool",
            "browser.",
            "memory.",
            "tasks.",
            "mcp.",
        ] {
            assert!(
                !grammar.contains(excluded),
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
        let grammar = grammar_with_skills(&["pdf"]);
        for name in GRAMMAR_TOOL_NAMES {
            assert!(
                grammar.contains(&gbnf_json_literal(name)),
                "grammar is missing `{name}`"
            );
        }
    }

    #[test]
    fn emits_every_static_tool_with_its_exact_argument_rule() {
        let grammar = grammar_with_skills(&[]);
        for tool in STATIC_TOOL_GRAMMARS {
            assert!(grammar.contains(&format!(
                "{}-call ::= call-prefix {} args-prefix {}-args call-suffix",
                tool.rule,
                gbnf_json_literal(tool.name),
                tool.rule
            )));
            assert!(
                grammar.contains(&format!("{}-args ::= {}", tool.rule, tool.args)),
                "grammar emitted the wrong args rule for `{}`",
                tool.name
            );
        }
    }

    #[test]
    fn more_specific_names_precede_their_prefixes() {
        let grammar = grammar_with_skills(&[]);
        let idx = |needle: &str| grammar.find(needle).unwrap_or(usize::MAX);
        assert!(idx(r#""\"os.fs.read_document\"""#) < idx(r#""\"os.fs.read\"""#));
        assert!(idx(r#""\"os.fs.archive.list\"""#) < idx(r#""\"os.fs.list\"""#));
        assert!(idx(r#""\"os.fs.archive.read_entry\"""#) < idx(r#""\"os.fs.read\"""#));
    }

    #[test]
    fn json_structural_rules_present() {
        let grammar = grammar_with_skills(&[]);
        for rule in [
            "string-map ::=",
            "string-array ::=",
            "non-empty-string-array ::=",
            "string ::=",
            "non-empty-string ::=",
            "nonnegative-integer ::=",
            "positive-integer ::=",
            "boolean ::=",
            "ws ::=",
        ] {
            assert!(
                grammar.contains(rule),
                "grammar missing structural rule `{rule}`"
            );
        }
    }

    #[test]
    fn enumerates_only_enabled_skills_and_rare_tools() {
        let grammar = grammar_with_skills(&["pdf", "web-research"]);
        assert!(grammar.contains(r#"skill-name ::= "\"pdf\"" | "\"web-research\"""#));
        assert!(grammar.contains(r#""\"os.fs.hash\"""#));
        assert!(!grammar.contains(r#""\"os.fs.read\"" |"#));
    }

    #[test]
    fn omits_skill_calls_when_no_skill_is_available() {
        let grammar = grammar_with_skills(&[]);
        let tool_call_rule = grammar.lines().nth(1).unwrap();
        assert!(!tool_call_rule.contains("skill-view-call"));
        assert!(!tool_call_rule.contains("skill-run-script-call"));
        assert!(!grammar.contains("skill-name ::="));
    }

    #[test]
    fn web_fetch_has_an_exact_non_empty_url_schema() {
        let grammar = grammar_with_skills(&[]);
        assert!(
            grammar.contains(r#"web-fetch-args ::= "{" ws "\"url\"" ws ":" ws non-empty-string"#)
        );
        assert!(!grammar.contains(r#""\"cmd\"" ws ":" ws "\"os.web.fetch\"""#));
        assert!(!grammar.contains(r#""\"\"" ws ":""#));
        assert!(!grammar.contains("generic-tool-call"));
        assert!(!grammar.contains("pair ::="));
    }

    #[test]
    fn escapes_json_literals_for_gbnf_terminals() {
        assert_eq!(
            gbnf_json_literal("quoted\"name\\tail"),
            r#""\"quoted\\\"name\\\\tail\"""#
        );
    }
}
