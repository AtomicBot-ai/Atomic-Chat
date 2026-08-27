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
        name: "docs.list",
        rule: "docs-list",
        args: r#""{" ws ( "\"scope\"" ws ":" ws ( "\"thread\"" | "\"project\"" ) ws )? "}""#,
    },
    ToolGrammar {
        name: "docs.retrieve",
        rule: "docs-retrieve",
        args: r#""{" ws "\"query\"" ws ":" ws non-empty-string ( ws "," ws "\"top_k\"" ws ":" ws positive-integer )? ( ws "," ws "\"file_ids\"" ws ":" ws non-empty-string-array )? ( ws "," ws "\"scope\"" ws ":" ws ( "\"thread\"" | "\"project\"" ) )? ws "}""#,
    },
    ToolGrammar {
        name: "docs.chunks",
        rule: "docs-chunks",
        args: r#""{" ws "\"file_id\"" ws ":" ws non-empty-string ws "," ws "\"start_order\"" ws ":" ws nonnegative-integer ws "," ws "\"end_order\"" ws ":" ws nonnegative-integer ( ws "," ws "\"scope\"" ws ":" ws ( "\"thread\"" | "\"project\"" ) )? ws "}""#,
    },
    ToolGrammar {
        name: "os.media.transcribe",
        rule: "media-transcribe",
        args: r#""{" ws "\"path\"" ws ":" ws non-empty-string ( ws "," ws "\"language\"" ws ":" ws non-empty-string )? ws "}""#,
    },
    ToolGrammar {
        name: "os.media.youtube",
        rule: "media-youtube",
        args: r#""{" ws "\"url\"" ws ":" ws non-empty-string ( ws "," ws "\"mode\"" ws ":" ws ( "\"transcript\"" | "\"frames\"" ) )? ( ws "," ws "\"maxFrames\"" ws ":" ws positive-integer )? ws "}""#,
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
        name: "os.code.symbols",
        rule: "code-symbols",
        args: r#""{" ws "\"path\"" ws ":" ws non-empty-string ws "}""#,
    },
    ToolGrammar {
        name: "os.code.find",
        rule: "code-find",
        args: r#""{" ws "\"name\"" ws ":" ws non-empty-string ( ws "," ws "\"kind\"" ws ":" ws symbol-kind )? ( ws "," ws "\"limit\"" ws ":" ws positive-integer )? ws "}""#,
    },
    ToolGrammar {
        name: "os.code.refs",
        rule: "code-refs",
        args: r#""{" ws "\"name\"" ws ":" ws non-empty-string ( ws "," ws "\"path\"" ws ":" ws non-empty-string )? ( ws "," ws "\"limit\"" ws ":" ws positive-integer )? ws "}""#,
    },
    ToolGrammar {
        name: "os.proc.spawn",
        rule: "proc-spawn",
        args: r#""{" ws "\"cmd\"" ws ":" ws non-empty-string ( ws "," ws "\"args\"" ws ":" ws string-array )? ( ws "," ws "\"cwd\"" ws ":" ws non-empty-string )? ( ws "," ws "\"cols\"" ws ":" ws positive-integer )? ( ws "," ws "\"rows\"" ws ":" ws positive-integer )? ws "}""#,
    },
    ToolGrammar {
        name: "os.proc.read",
        rule: "proc-read",
        args: r#""{" ws "\"procId\"" ws ":" ws non-empty-string ( ws "," ws "\"since\"" ws ":" ws nonnegative-integer )? ( ws "," ws "\"maxChars\"" ws ":" ws positive-integer )? ws "}""#,
    },
    ToolGrammar {
        name: "os.proc.write",
        rule: "proc-write",
        args: r#""{" ws "\"procId\"" ws ":" ws non-empty-string ws "," ws "\"data\"" ws ":" ws string ws "}""#,
    },
    ToolGrammar {
        name: "os.proc.stop",
        rule: "proc-stop",
        args: r#""{" ws "\"procId\"" ws ":" ws non-empty-string ( ws "," ws "\"signal\"" ws ":" ws ( "\"SIGTERM\"" | "\"SIGKILL\"" | "\"SIGINT\"" | "\"SIGHUP\"" ) )? ws "}""#,
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
    "docs.list",
    "docs.retrieve",
    "docs.chunks",
    "os.media.transcribe",
    "os.media.youtube",
    "vision.describe",
    "os.git.status",
    "os.git.log",
    "os.git.diff",
    "os.git.show",
    "os.git.blame",
    "os.git.branch",
    "os.proc.list",
    "os.proc.kill",
    "os.code.symbols",
    "os.code.find",
    "os.code.refs",
    "os.proc.spawn",
    "os.proc.read",
    "os.proc.write",
    "os.proc.stop",
    "os.clipboard.read",
    "os.clipboard.write",
    "os.notify",
    "reply",
    "finish",
];

/// Build the tool-call grammar from the fixed tool catalog and the enabled,
/// compatible skill registry visible to this turn.
pub fn tool_call_grammar(skill_registry: &SkillRegistry) -> String {
    tool_call_grammar_for_profile(skill_registry, AgentModelProfile::Plain, false)
}

/// Tags a generic thinking block is delimited by, for models whose profile has
/// no native reasoning channel of its own. The pair is also what the llama.cpp
/// reasoning-budget sampler is armed with, so the two must stay identical.
pub const GENERIC_THINK_OPEN: &str = "<think>";
pub const GENERIC_THINK_CLOSE: &str = "</think>";

/// `thinking` asks for a reasoning prelude ahead of the tool-call array. It is
/// ignored for `Gemma4Think`, whose channel prelude is native turn framing
/// rather than an effort choice and is therefore always present.
pub fn tool_call_grammar_for_profile(
    skill_registry: &SkillRegistry,
    profile: AgentModelProfile,
    thinking: bool,
) -> String {
    tool_call_grammar_dynamic(
        skill_registry,
        profile,
        thinking,
        &[],
        &std::collections::BTreeSet::new(),
    )
}

/// The full dynamic form: `mcp_names` stitches the turn's MCP catalog into the
/// grammar (generalizing the skill-name pattern), `disabled` removes built-in
/// tools switched off for this turn (e.g. `os.web.*` when web search is off).
pub fn tool_call_grammar_dynamic(
    skill_registry: &SkillRegistry,
    profile: AgentModelProfile,
    thinking: bool,
    mcp_names: &[String],
    disabled: &std::collections::BTreeSet<String>,
) -> String {
    let skill_names = skill_registry
        .enabled()
        .map(|record| record.manifest.name.as_str())
        .collect::<Vec<_>>();
    let enabled_static = STATIC_TOOL_GRAMMARS
        .iter()
        .filter(|grammar| !disabled.contains(grammar.name))
        .collect::<Vec<_>>();
    let mut call_rules = enabled_static
        .iter()
        .map(|grammar| format!("{}-call", grammar.rule))
        .collect::<Vec<_>>();
    if !skill_names.is_empty() {
        call_rules.insert(1, "skill-view-call".into());
        call_rules.insert(2, "skill-run-script-call".into());
    }
    if !mcp_names.is_empty() {
        call_rules.push("mcp-call".into());
    }

    // At most one prelude: emitting two would duplicate `prelude-trail-ws` and
    // make the grammar unparseable.
    let prelude = match (profile.reasoning_open_tag(), profile.reasoning_close_tag()) {
        (Some(open), Some(close)) => Some(("channel", open, close)),
        _ if thinking => Some(("think", GENERIC_THINK_OPEN, GENERIC_THINK_CLOSE)),
        _ => None,
    };
    let root = match prelude {
        Some((stem, _, _)) => format!("{stem}-prelude tool-call-array"),
        None => "tool-call-array".to_string(),
    };
    let mut grammar = format!(
        "root ::= {root}\ntool-call ::= {}\n",
        call_rules.join(" | ")
    );
    for tool in &enabled_static {
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

    if !mcp_names.is_empty() {
        // MCP args are validated by the serving MCP server (and previewed for
        // approval), so the grammar pins only "a JSON object" — the generic
        // value rules exist solely for this branch.
        grammar.push_str(
            "mcp-call ::= call-prefix mcp-tool-name args-prefix json-object call-suffix\n",
        );
        writeln!(
            grammar,
            "mcp-tool-name ::= {}",
            mcp_names
                .iter()
                .map(|name| gbnf_json_literal(name))
                .collect::<Vec<_>>()
                .join(" | ")
        )
        .expect("writing mcp grammar to String cannot fail");
        grammar.push_str(
            "json-object ::= \"{\" ws ( json-member ( ws \",\" ws json-member )* )? ws \"}\"\n\
             json-member ::= string ws \":\" ws json-value\n\
             json-array-generic ::= \"[\" ws ( json-value ( ws \",\" ws json-value )* )? ws \"]\"\n\
             json-value ::= string | json-number | json-object | json-array-generic | boolean | \"null\"\n\
             json-number ::= \"-\"? ( \"0\" | [1-9] [0-9]* ) ( \".\" [0-9]+ )? ( [eE] [+-]? [0-9]+ )?\n",
        );
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

    grammar.push_str(
        "symbol-kind ::= \"\\\"class\\\"\" | \"\\\"struct\\\"\" | \"\\\"enum\\\"\" | \"\\\"trait\\\"\" | \"\\\"interface\\\"\" | \"\\\"method\\\"\" | \"\\\"function\\\"\" | \"\\\"macro\\\"\" | \"\\\"type\\\"\" | \"\\\"module\\\"\" | \"\\\"constant\\\"\"\n",
    );

    // MCP tools join the rare-name alternation so `tool.view` can load their
    // full schemas into the variable tail on demand.
    let rare_tool_names = ITERATION_ONE_TOOLS
        .iter()
        .filter(|descriptor| descriptor.tier == ToolTier::Rare)
        .filter(|descriptor| !disabled.contains(descriptor.name))
        .map(|descriptor| gbnf_json_literal(descriptor.name))
        .chain(mcp_names.iter().map(|name| gbnf_json_literal(name)))
        .collect::<Vec<_>>();
    writeln!(
        grammar,
        "rare-tool-name ::= {}",
        rare_tool_names.join(" | ")
    )
    .expect("writing rare tool grammar to String cannot fail");
    grammar.push_str(JSON_RULES);
    if let Some((stem, open, close)) = prelude {
        write_reasoning_prelude(&mut grammar, stem, open, close);
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
        let grammar =
            tool_call_grammar_for_profile(&registry, AgentModelProfile::Gemma4Think, false);

        assert!(grammar.starts_with("root ::= channel-prelude tool-call-array\n"));
        assert!(grammar.contains(
            "channel-prelude ::= \"<|channel>thought\\n\" channel-body \"<channel|>\" prelude-trail-ws"
        ));
        assert!(grammar.contains("prelude-trail-ws ::= ( [ \\t\\n\\r] ){0,8}"));
    }

    fn empty_registry(temp: &TempDir) -> SkillRegistry {
        let root = temp.path().join("skills");
        fs::create_dir_all(&root).unwrap();
        SkillRegistry::load(&root, &BTreeSet::new(), &BTreeSet::new()).unwrap()
    }

    #[test]
    fn plain_grammar_gets_a_think_prelude_when_thinking_is_on() {
        let temp = TempDir::new().unwrap();
        let registry = empty_registry(&temp);
        let grammar = tool_call_grammar_for_profile(&registry, AgentModelProfile::Plain, true);

        assert!(grammar.starts_with("root ::= think-prelude tool-call-array\n"));
        assert!(grammar
            .contains("think-prelude ::= \"<think>\" think-body \"</think>\" prelude-trail-ws"));
        // The close tag is peeled one character at a time so the body can never
        // swallow it.
        assert!(grammar.contains("think-fragment ::= [^<]+ | \"<\" [^/]"));
        assert!(grammar.contains("\"</think\" [^>]"));
    }

    #[test]
    fn plain_grammar_stays_array_only_when_thinking_is_off() {
        let temp = TempDir::new().unwrap();
        let registry = empty_registry(&temp);
        let grammar = tool_call_grammar_for_profile(&registry, AgentModelProfile::Plain, false);

        assert!(grammar.starts_with("root ::= tool-call-array\n"));
        assert!(!grammar.contains("think-prelude"));
        assert!(!grammar.contains("prelude-trail-ws"));
    }

    /// The `mcp.` namespace is reserved for dynamic MCP tools; a built-in tool
    /// using it would shadow the catalog's reverse mapping.
    #[test]
    fn no_builtin_tool_uses_the_mcp_namespace() {
        for name in GRAMMAR_TOOL_NAMES {
            assert!(
                !name.starts_with("mcp."),
                "built-in tool `{name}` uses the reserved mcp. namespace"
            );
        }
        for descriptor in ITERATION_ONE_TOOLS {
            assert!(!descriptor.name.starts_with("mcp."));
        }
    }

    #[test]
    fn mcp_names_get_an_alternation_and_generic_json_rules() {
        let temp = TempDir::new().unwrap();
        let registry = empty_registry(&temp);
        let names = vec![
            "mcp.github.create_issue".to_string(),
            "mcp.linear.search".to_string(),
        ];
        let grammar = tool_call_grammar_dynamic(
            &registry,
            AgentModelProfile::Plain,
            false,
            &names,
            &BTreeSet::new(),
        );

        assert!(grammar.contains("| mcp-call\n"));
        assert!(grammar
            .contains("mcp-call ::= call-prefix mcp-tool-name args-prefix json-object call-suffix"));
        assert!(grammar.contains(
            r#"mcp-tool-name ::= "\"mcp.github.create_issue\"" | "\"mcp.linear.search\"""#
        ));
        assert!(grammar.contains("json-value ::="));
        // `tool.view` can name an MCP tool.
        assert!(grammar.contains(r#"rare-tool-name ::="#));
        let rare_line = grammar
            .lines()
            .find(|line| line.starts_with("rare-tool-name ::="))
            .expect("rare-tool-name rule");
        assert!(rare_line.contains("mcp.github.create_issue"));
    }

    #[test]
    fn empty_mcp_catalog_leaves_the_grammar_byte_identical() {
        let temp = TempDir::new().unwrap();
        let registry = empty_registry(&temp);
        let baseline = tool_call_grammar_for_profile(&registry, AgentModelProfile::Plain, false);
        let dynamic = tool_call_grammar_dynamic(
            &registry,
            AgentModelProfile::Plain,
            false,
            &[],
            &BTreeSet::new(),
        );
        assert_eq!(baseline, dynamic);
        assert!(!baseline.contains("json-value"));
        assert!(!baseline.contains("mcp-call"));
    }

    #[test]
    fn disabled_web_tools_leave_grammar_and_dispatch_rules() {
        let temp = TempDir::new().unwrap();
        let registry = empty_registry(&temp);
        let disabled: BTreeSet<String> = ["os.web.search", "os.web.fetch"]
            .into_iter()
            .map(str::to_owned)
            .collect();
        let grammar = tool_call_grammar_dynamic(
            &registry,
            AgentModelProfile::Plain,
            false,
            &[],
            &disabled,
        );

        assert!(!grammar.contains(r#""\"os.web.search\"""#));
        assert!(!grammar.contains(r#""\"os.web.fetch\"""#));
        // Unrelated tools survive the filter.
        assert!(grammar.contains(r#""\"os.fs.read\"""#));
        assert!(grammar.contains(r#""\"reply\"""#));
    }

    #[test]
    fn disabled_docs_tools_leave_grammar_and_dispatch_rules() {
        let temp = TempDir::new().unwrap();
        let registry = empty_registry(&temp);
        let disabled: BTreeSet<String> = ["docs.list", "docs.retrieve", "docs.chunks"]
            .into_iter()
            .map(str::to_owned)
            .collect();
        let grammar = tool_call_grammar_dynamic(
            &registry,
            AgentModelProfile::Plain,
            false,
            &[],
            &disabled,
        );

        assert!(!grammar.contains(r#""\"docs.list\"""#));
        assert!(!grammar.contains(r#""\"docs.retrieve\"""#));
        assert!(!grammar.contains(r#""\"docs.chunks\"""#));
        // Unrelated tools survive the filter.
        assert!(grammar.contains(r#""\"os.fs.read\"""#));
        assert!(grammar.contains(r#""\"reply\"""#));
    }

    #[test]
    fn gemma4_keeps_its_channel_prelude_whatever_the_thinking_flag_says() {
        let temp = TempDir::new().unwrap();
        let registry = empty_registry(&temp);
        let off = tool_call_grammar_for_profile(&registry, AgentModelProfile::Gemma4Think, false);
        let on = tool_call_grammar_for_profile(&registry, AgentModelProfile::Gemma4Think, true);

        // The channel prelude is native turn framing, not an effort choice.
        assert_eq!(off, on);
        assert!(!on.contains("think-prelude"));
    }

    #[test]
    fn at_most_one_prelude_is_ever_emitted() {
        let temp = TempDir::new().unwrap();
        let registry = empty_registry(&temp);
        for profile in [AgentModelProfile::Plain, AgentModelProfile::Gemma4Think] {
            for thinking in [false, true] {
                let grammar = tool_call_grammar_for_profile(&registry, profile, thinking);
                // A duplicate rule definition would make the GBNF unparseable.
                assert!(grammar.matches("prelude-trail-ws ::=").count() <= 1);
            }
        }
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

    /// Split a GBNF body into the identifiers it *references*, ignoring string
    /// literals and character classes where the same characters are data.
    fn referenced_rules(body: &str) -> Vec<String> {
        let bytes: Vec<char> = body.chars().collect();
        let mut names = Vec::new();
        let mut index = 0;
        while index < bytes.len() {
            match bytes[index] {
                // A quoted literal: skip it whole, honouring backslash escapes.
                '"' => {
                    index += 1;
                    while index < bytes.len() && bytes[index] != '"' {
                        index += if bytes[index] == '\\' { 2 } else { 1 };
                    }
                    index += 1;
                }
                // A character class: same idea.
                '[' => {
                    index += 1;
                    while index < bytes.len() && bytes[index] != ']' {
                        index += if bytes[index] == '\\' { 2 } else { 1 };
                    }
                    index += 1;
                }
                character if character.is_ascii_alphabetic() => {
                    let start = index;
                    while index < bytes.len()
                        && (bytes[index].is_ascii_alphanumeric() || bytes[index] == '-')
                    {
                        index += 1;
                    }
                    names.push(bytes[start..index].iter().collect::<String>());
                }
                _ => index += 1,
            }
        }
        names
    }

    /// Every non-terminal the grammar mentions must also be defined.
    ///
    /// Nothing else checks this: llama.cpp only discovers a dangling rule when
    /// it compiles the grammar mid-run, and the failure surfaces as a broken
    /// agent on local models rather than a failing build. Adding a tool means
    /// hand-writing GBNF, which is exactly where a typo lands.
    #[test]
    fn the_symbol_kind_rule_emits_quoted_json_literals() {
        // The rule is built from a hand-escaped Rust string; a wrong number of
        // backslashes yields GBNF that parses but matches the wrong bytes,
        // which `every_referenced_grammar_rule_is_defined` would not catch.
        let temp = TempDir::new().expect("temp dir");
        let grammar = tool_call_grammar_for_profile(
            &empty_registry(&temp),
            AgentModelProfile::Plain,
            false,
        );
        let line = grammar
            .lines()
            .find(|line| line.starts_with("symbol-kind ::="))
            .expect("symbol-kind must be defined");
        assert!(line.contains(r#""\"function\"""#), "{line}");
        assert!(line.contains(r#""\"constant\"""#), "{line}");
        assert_eq!(line.matches('|').count(), 10, "eleven alternatives: {line}");
    }

    #[test]
    fn every_referenced_grammar_rule_is_defined() {
        let temp = TempDir::new().expect("temp dir");
        for thinking in [false, true] {
            for profile in [
                AgentModelProfile::Plain,
                AgentModelProfile::Gemma4Think,
            ] {
                let grammar =
                    tool_call_grammar_for_profile(&empty_registry(&temp), profile, thinking);
                let mut defined = std::collections::HashSet::new();
                let mut referenced = Vec::new();
                for line in grammar.lines() {
                    let Some((head, body)) = line.split_once("::=") else {
                        continue;
                    };
                    defined.insert(head.trim().to_owned());
                    referenced.extend(referenced_rules(body));
                }
                for name in referenced {
                    assert!(
                        defined.contains(&name),
                        "rule `{name}` is referenced but never defined \
                         (profile {profile:?}, thinking={thinking})"
                    );
                }
            }
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
