//! System prompt assembly for the agent (stable prefix + variable tail).
//!
//! Ported from the TypeScript `atomic-agent` prompt layer
//! (`stable-prefix.ts` + `build-prompt.ts`). The prompt is a **stable
//! prefix** — persona + `### rules` + `### tools` + `### capabilities` +
//! `### instructions` — that must stay byte-identical within a session so
//! `llama-server`'s `cache_prompt` + `slot_id` KV-cache reuse holds, followed
//! by a **variable tail** (`### conversation`, optional `### notice`, and the
//! `### respond` emit anchor).
//!
//! Iteration 1 hardcodes a fixed tool set (see [`ITERATION_ONE_TOOLS`]) — no
//! `browser` / `memory` / `tasks` / `skill` / `vision` / `mcp` tools — so the
//! grammar and descriptors are static.

/// Tier of a tool descriptor in the `### tools` catalog. `Frequent` tools
/// render with their full `args` schema under `# common (full)`; `Rare` tools
/// render as one-line entries under `# extras`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolTier {
    Frequent,
    Rare,
}

/// A single tool the model may call, rendered into the `### tools` block.
/// Ported from `ToolDescriptor` (`stable-prefix.ts`).
#[derive(Debug, Clone)]
pub struct ToolDescriptor {
    pub name: &'static str,
    pub summary: &'static str,
    pub args_schema: &'static str,
    pub tier: ToolTier,
    pub examples: &'static [&'static str],
}

/// Environment description rendered into the `### capabilities` block.
/// Ported from `CapabilitiesSummary` (`stable-prefix.ts`). `platform` mirrors
/// the NodeJS values (`"win32"` / `"darwin"` / `"linux"`) so the Windows hint
/// gating matches the TS source verbatim.
#[derive(Debug, Clone)]
pub struct CapabilitiesSummary {
    pub platform: String,
    pub arch: String,
    pub browser_channel: String,
    pub working_dir: String,
    pub has_clipboard: bool,
    pub has_wmctrl: bool,
    pub has_notifications: bool,
}

/// Default number of parallel tool calls advertised in `### instructions`.
/// Mirrors `agent.maxParallelToolCalls` (default 8) in `atomic-agent`.
pub const DEFAULT_MAX_PARALLEL_TOOL_CALLS: usize = 8;

/// Persona lines, joined with `\n`. Ported verbatim from
/// `DEFAULT_SYSTEM_PERSONA` (`stable-prefix.ts`).
const DEFAULT_SYSTEM_PERSONA_LINES: &[&str] = &[
    "You are a capable autonomous operator agent running locally on the user's machine.",
    "You accomplish tasks by calling tools, observing results, and iterating until the task is done.",
    "",
    "Operating principles:",
    "- Think, then act. Emit a small batch of tool calls, observe the results, then decide the next step. One inference = one JSON array of tool calls.",
    "- Prefer the cheapest tool that answers the question. Read before you write. Never guess a file's contents — read it.",
    "- Batch independent read-only calls together (they run in parallel). Anything that mutates state, or a terminal verb, must be the last element of a batch.",
    "- Be decisive. Do not narrate what you are about to do in prose — call the tool. Do not ask for confirmation unless a tool is approval-gated.",
    "- When the task is complete, call `reply` with the final answer. Only call `finish` if the user explicitly asked to end the session.",
    "- Keep `reply` short and to the point. If the user asked for an exact value or marker, `reply.text` must be ONLY that bare value — no preamble, no restating the question, no extra commentary or markdown before or after.",
    "- Respect the loop guard. If you are told a call was denied as a loop, change your approach — do not repeat the same call.",
];

/// Windows-specific shell hint, appended to `### capabilities` when the
/// platform is `win32`. Ported verbatim from `WINDOWS_PLATFORM_HINT`.
const WINDOWS_PLATFORM_HINT_LINES: &[&str] = &[
    "Windows environment: `os.shell.run` uses a `cmd.exe` subshell. Prefer native Windows commands — `findstr` (not grep), `where` (not which), `type` (not cat), `dir` (not `ls -la`), `copy`/`move`/`ren`, `del`/`rmdir` semantics. Reference environment variables as `%VAR%` and use backslash `\\` path separators (e.g. `C:\\Users\\me\\file.txt`). Chain commands with `&&`, `||`, and pipe with `|`.",
];

/// The fixed iteration-1 tool catalog. Order is load-bearing — it mirrors the
/// order of `DEFAULT_TOOL_DESCRIPTORS` (A then B) in `atomic-agent`, filtered
/// to the iteration-1 set (pure_read + approval_gated + terminal). Keeping the
/// order stable keeps the rendered `### tools` block byte-stable across runs.
pub const ITERATION_ONE_TOOLS: &[ToolDescriptor] = &[
    ToolDescriptor {
        name: "os.shell.run",
        summary: "Run a shell command. Direct-exec by default; routes through a subshell when the command needs shell interpretation. Approval-gated. Prefer a dedicated fs/git tool when one exists.",
        args_schema: r#"{ cmd: string, args?: string[], cwd?: string, timeoutMs?: number }"#,
        tier: ToolTier::Frequent,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.fs.read",
        summary: "Read a text file. Supports offset/limit line windows and optional line numbers.",
        args_schema: r#"{ path: string, offset?: number, limit?: number, lineNumbers?: boolean }"#,
        tier: ToolTier::Frequent,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.fs.write",
        summary: "Write (create or overwrite) a text file. Approval-gated.",
        args_schema: r#"{ path: string, content: string }"#,
        tier: ToolTier::Frequent,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.fs.trash",
        summary: "Move a file or directory to the OS trash (recoverable). Approval-gated.",
        args_schema: r#"{ path: string }"#,
        tier: ToolTier::Frequent,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.fs.list",
        summary: "List a directory (non-recursive by default) with optional filtering and sorting.",
        args_schema: r#"{ path: string, pattern?: string, kind?: "file" | "dir", extensions?: string[], sort?: "name" | "size" | "mtime", maxEntries?: number }"#,
        tier: ToolTier::Frequent,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.fs.glob",
        summary: "Find files by glob pattern (e.g. src/**/*.ts). Read-only.",
        args_schema: r#"{ pattern: string, cwd?: string, maxEntries?: number }"#,
        tier: ToolTier::Frequent,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.fs.grep",
        summary: "Search file contents with a regex (bundled ripgrep). Read-only.",
        args_schema: r#"{ pattern: string, path?: string, glob?: string, maxMatches?: number, ignoreCase?: boolean }"#,
        tier: ToolTier::Frequent,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.fs.edit",
        summary: "Atomic string replacement in a file (old -> new, must be unique unless replaceAll). Approval-gated.",
        args_schema: r#"{ path: string, oldString: string, newString: string, replaceAll?: boolean }"#,
        tier: ToolTier::Frequent,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.fs.read_document",
        summary: "Extract plain text from a PDF/DOCX/XLSX/RTF/ODT/PPTX/legacy-doc file. Read-only.",
        args_schema: r#"{ path: string, maxChars?: number }"#,
        tier: ToolTier::Frequent,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.fs.archive.list",
        summary: "List entries in a zip/tar/tar.gz/gz archive without extracting. Read-only.",
        args_schema: r#"{ path: string, maxEntries?: number }"#,
        tier: ToolTier::Rare,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.fs.archive.read_entry",
        summary: "Read a single entry from an archive as text. Read-only.",
        args_schema: r#"{ path: string, entry: string, maxChars?: number }"#,
        tier: ToolTier::Rare,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.fs.archive.extract",
        summary: "Extract an archive to a directory (zip-slip + bomb guarded). Approval-gated.",
        args_schema: r#"{ path: string, dest: string }"#,
        tier: ToolTier::Rare,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.fs.hash",
        summary: "Compute a streaming md5/sha1/sha256/sha512 digest of a file. Read-only.",
        args_schema: r#"{ path: string, algorithm?: "md5" | "sha1" | "sha256" | "sha512" }"#,
        tier: ToolTier::Rare,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.fs.diff",
        summary: "Unified diff between two files. Read-only.",
        args_schema: r#"{ pathA: string, pathB: string }"#,
        tier: ToolTier::Rare,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.fs.patch",
        summary: "Apply a unified diff to files (dry-run by default; all-or-nothing on apply). Approval-gated on apply.",
        args_schema: r#"{ patch: string, apply?: boolean }"#,
        tier: ToolTier::Rare,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.git.status",
        summary: "Show working-tree status (porcelain, parsed). Read-only.",
        args_schema: r#"{ cwd?: string }"#,
        tier: ToolTier::Frequent,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.git.log",
        summary: "Show recent commits (parsed). Read-only.",
        args_schema: r#"{ cwd?: string, maxCount?: number, path?: string }"#,
        tier: ToolTier::Frequent,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.git.diff",
        summary: "Show a diff (working tree, staged, or between revisions). Read-only.",
        args_schema: r#"{ cwd?: string, staged?: boolean, revision?: string, path?: string }"#,
        tier: ToolTier::Frequent,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.git.show",
        summary: "Show a commit or object. Read-only.",
        args_schema: r#"{ cwd?: string, revision: string }"#,
        tier: ToolTier::Rare,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.git.blame",
        summary: "Show line-by-line authorship for a file. Read-only.",
        args_schema: r#"{ cwd?: string, path: string }"#,
        tier: ToolTier::Rare,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.git.branch",
        summary: "List branches. Read-only.",
        args_schema: r#"{ cwd?: string }"#,
        tier: ToolTier::Rare,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.proc.list",
        summary: "List running processes (ps/tasklist, parsed). Read-only.",
        args_schema: r#"{ filter?: string, maxEntries?: number }"#,
        tier: ToolTier::Frequent,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.proc.kill",
        summary: "Terminate a process by pid. Approval-gated.",
        args_schema: r#"{ pid: number, signal?: string }"#,
        tier: ToolTier::Frequent,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.http.request",
        summary: "Make an HTTP request (curl-backed, host-allowlisted, SSRF-guarded). Approval-gated. Use for raw API/JSON or non-GET; for reading a web page use os.web.fetch.",
        args_schema: r#"{ url: string, method?: string, headers?: Record<string, string>, body?: string, timeoutMs?: number }"#,
        tier: ToolTier::Frequent,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.web.search",
        summary: "Search the web via the configured provider (keyless DuckDuckGo by default). Returns titles + URLs + snippets. Read-only.",
        args_schema: r#"{ query: string, maxResults?: number }"#,
        tier: ToolTier::Frequent,
        examples: &[
            r#"{"query":"rust tokio oneshot channel example"}"#,
        ],
    },
    ToolDescriptor {
        name: "os.web.fetch",
        summary: "Read a web page as readable markdown/text (cf-markdown -> Readability -> basic). GET only, no JS, no auth; SSRF-guarded; read-only. For raw API/JSON or POST, use os.http.request.",
        args_schema: r#"{ url: string, extractMode?: "markdown" | "text", maxChars?: number }"#,
        tier: ToolTier::Frequent,
        examples: &[
            r#"{"url":"https://example.com/article"}"#,
            r#"{"url":"https://docs.example.com/guide","extractMode":"text","maxChars":20000}"#,
        ],
    },
    ToolDescriptor {
        name: "os.clipboard.read",
        summary: "Read the system clipboard as text.",
        args_schema: r#"{}"#,
        tier: ToolTier::Rare,
        examples: &[],
    },
    ToolDescriptor {
        name: "reply",
        summary: "Final natural-language answer; ends the macro-turn. Never use to announce a pending action; keep text short (no huge dumps). If the task requires an exact answer format or marker, `text` must be ONLY that bare value or marker line — no preamble or commentary.",
        args_schema: r#"{ text: string }"#,
        tier: ToolTier::Frequent,
        examples: &[],
    },
    ToolDescriptor {
        name: "finish",
        summary: "End the session with a final summary; only if the user asked to end.",
        args_schema: r#"{ summary: string }"#,
        tier: ToolTier::Frequent,
        examples: &[],
    },
];

/// Render the persona (joined with `\n`).
pub fn default_system_persona() -> String {
    DEFAULT_SYSTEM_PERSONA_LINES.join("\n")
}

/// Render one `Frequent` tool with its full `args` schema and any examples.
/// Ported from `formatToolFrequent` (`stable-prefix.ts`).
fn format_tool_frequent(descriptor: &ToolDescriptor) -> String {
    let mut out = format!(
        "- {} {}\n  {}",
        descriptor.name, descriptor.args_schema, descriptor.summary
    );
    for example in descriptor.examples {
        out.push_str("\n  e.g. ");
        out.push_str(example);
    }
    out
}

/// Render one `Rare` tool as a compact one-line entry (no full schema).
/// Ported from `formatToolRare` (`stable-prefix.ts`).
fn format_tool_rare(descriptor: &ToolDescriptor) -> String {
    format!("- {} — {}", descriptor.name, descriptor.summary)
}

/// Render the `### capabilities` body. Ported from `formatCapabilities`.
fn format_capabilities(caps: &CapabilitiesSummary) -> String {
    let mut lines = vec![
        format!("platform: {} ({})", caps.platform, caps.arch),
        format!("working directory: {}", caps.working_dir),
        format!("browser channel: {}", caps.browser_channel),
        format!(
            "clipboard: {}",
            if caps.has_clipboard {
                "available"
            } else {
                "unavailable"
            }
        ),
        format!(
            "window control (wmctrl): {}",
            if caps.has_wmctrl {
                "available"
            } else {
                "unavailable"
            }
        ),
        format!(
            "desktop notifications: {}",
            if caps.has_notifications {
                "available"
            } else {
                "unavailable"
            }
        ),
    ];
    if caps.platform == "win32" {
        lines.push(String::new());
        lines.push(WINDOWS_PLATFORM_HINT_LINES.join("\n"));
    }
    lines.join("\n")
}

/// Build the stable prefix — persona + `### rules` + `### tools` +
/// `### capabilities` + `### instructions`. Must stay byte-identical within a
/// session for KV-cache reuse. Ported from `buildStablePrefix`.
pub fn build_stable_prefix(
    tool_descriptors: &[ToolDescriptor],
    capabilities: &CapabilitiesSummary,
    max_parallel_tool_calls: usize,
    system_persona: Option<&str>,
) -> String {
    let persona = system_persona
        .map(str::to_string)
        .unwrap_or_else(default_system_persona);

    let mut sections: Vec<String> = Vec::new();

    sections.push(format!("### system\n{persona}"));

    sections.push(
        [
            "### rules",
            "- Every response is a JSON array of tool calls: [{\"tool\": ..., \"args\": {...}}, ...].",
            "- A solo step is a length-1 array. Emit multiple calls only when they are independent.",
            "- Read-only calls may be batched and run in parallel. A mutating call, or a terminal verb (reply/finish), must be the LAST element of the array.",
            "- Never emit prose outside the JSON array. Never invent tool names or arguments.",
            "- Call `reply` to answer the user; call `finish` only to end the whole session.",
        ]
        .join("\n"),
    );

    let frequent: Vec<&ToolDescriptor> = tool_descriptors
        .iter()
        .filter(|d| d.tier == ToolTier::Frequent)
        .collect();
    let rare: Vec<&ToolDescriptor> = tool_descriptors
        .iter()
        .filter(|d| d.tier == ToolTier::Rare)
        .collect();

    let mut tools_section = String::from("### tools");
    tools_section.push_str("\n# common (full)");
    for descriptor in &frequent {
        tools_section.push('\n');
        tools_section.push_str(&format_tool_frequent(descriptor));
    }
    if !rare.is_empty() {
        tools_section.push_str("\n# extras");
        for descriptor in &rare {
            tools_section.push('\n');
            tools_section.push_str(&format_tool_rare(descriptor));
        }
    }
    sections.push(tools_section);

    sections.push(format!(
        "### capabilities\n{}",
        format_capabilities(capabilities)
    ));

    sections.push(
        [
            "### instructions".to_string(),
            format!(
                "- Emit at most {max_parallel_tool_calls} tool calls per step. Fewer is fine; one is common."
            ),
            "- After each batch you will see the results under ### conversation. Use them to decide the next step.".to_string(),
            "- If a call is denied as a loop, do NOT repeat it — change tool, change arguments, or reply.".to_string(),
            "- Stop as soon as the task is done: call `reply` with the answer.".to_string(),
        ]
        .join("\n"),
    );

    sections.join("\n\n")
}

/// Assemble the full prompt: stable prefix + variable tail
/// (`### conversation`, optional `### notice`, `### respond` emit anchor).
/// Ported from `buildPrompt` (`build-prompt.ts`), narrowed to iteration 1.
pub fn build_prompt(stable_prefix: &str, conversation: &str, notice: Option<&str>) -> String {
    let mut tail: Vec<String> = Vec::new();

    tail.push("### conversation".to_string());
    tail.push(conversation.to_string());
    tail.push(String::new());

    if let Some(notice) = notice {
        if !notice.is_empty() {
            tail.push("### notice".to_string());
            tail.push(notice.to_string());
            tail.push(String::new());
        }
    }

    tail.push("### respond".to_string());
    tail.push("Respond now.".to_string());

    format!("{stable_prefix}\n{}", tail.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_caps(platform: &str) -> CapabilitiesSummary {
        CapabilitiesSummary {
            platform: platform.to_string(),
            arch: "x86_64".to_string(),
            browser_channel: "none".to_string(),
            working_dir: "/tmp/work".to_string(),
            has_clipboard: true,
            has_wmctrl: false,
            has_notifications: false,
        }
    }

    #[test]
    fn stable_prefix_has_all_sections_in_order() {
        let caps = test_caps("darwin");
        let prefix = build_stable_prefix(
            ITERATION_ONE_TOOLS,
            &caps,
            DEFAULT_MAX_PARALLEL_TOOL_CALLS,
            None,
        );

        let system = prefix.find("### system").expect("### system");
        let rules = prefix.find("### rules").expect("### rules");
        let tools = prefix.find("### tools").expect("### tools");
        let caps_idx = prefix.find("### capabilities").expect("### capabilities");
        let instructions = prefix.find("### instructions").expect("### instructions");

        assert!(prefix.starts_with("### system"));
        assert!(system < rules);
        assert!(rules < tools);
        assert!(tools < caps_idx);
        assert!(caps_idx < instructions);
    }

    #[test]
    fn stable_prefix_embeds_persona_first_line() {
        let caps = test_caps("linux");
        let prefix = build_stable_prefix(ITERATION_ONE_TOOLS, &caps, 8, None);
        assert!(prefix.contains("You are a capable autonomous operator agent"));
    }

    #[test]
    fn tools_block_renders_frequent_and_rare_partitions() {
        let caps = test_caps("linux");
        let prefix = build_stable_prefix(ITERATION_ONE_TOOLS, &caps, 8, None);

        assert!(prefix.contains("# common (full)"));
        assert!(prefix.contains("# extras"));

        // A frequent tool renders with its full args schema.
        assert!(prefix.contains("- os.fs.read { path: string"));
        // A rare tool renders as a one-line entry with an em-dash.
        assert!(prefix.contains("- os.git.blame — "));
    }

    #[test]
    fn terminal_verbs_are_present() {
        let caps = test_caps("linux");
        let prefix = build_stable_prefix(ITERATION_ONE_TOOLS, &caps, 8, None);
        assert!(prefix.contains("- reply {"));
        assert!(prefix.contains("- finish {"));
    }

    #[test]
    fn windows_hint_gated_on_platform() {
        let mac = build_stable_prefix(ITERATION_ONE_TOOLS, &test_caps("darwin"), 8, None);
        assert!(!mac.contains("cmd.exe subshell"));

        let win = build_stable_prefix(ITERATION_ONE_TOOLS, &test_caps("win32"), 8, None);
        assert!(win.contains("cmd.exe subshell"));
        assert!(win.contains("C:\\Users\\me\\file.txt"));
    }

    #[test]
    fn instructions_interpolate_parallel_cap() {
        let caps = test_caps("linux");
        let prefix = build_stable_prefix(ITERATION_ONE_TOOLS, &caps, 4, None);
        assert!(prefix.contains("Emit at most 4 tool calls per step"));
    }

    #[test]
    fn build_prompt_appends_tail_with_conversation_and_anchor() {
        let caps = test_caps("linux");
        let prefix = build_stable_prefix(ITERATION_ONE_TOOLS, &caps, 8, None);
        let full = build_prompt(&prefix, "USER: hello", None);

        assert!(full.starts_with(&prefix));
        assert!(full.contains("### conversation\nUSER: hello"));
        assert!(full.trim_end().ends_with("### respond\nRespond now."));
        assert!(!full.contains("### notice"));
    }

    #[test]
    fn build_prompt_includes_notice_when_present() {
        let caps = test_caps("linux");
        let prefix = build_stable_prefix(ITERATION_ONE_TOOLS, &caps, 8, None);
        let full = build_prompt(&prefix, "USER: hi", Some("You repeated os.fs.read 3 times."));
        assert!(full.contains("### notice\nYou repeated os.fs.read 3 times."));

        let empty = build_prompt(&prefix, "USER: hi", Some(""));
        assert!(!empty.contains("### notice"));
    }
}
