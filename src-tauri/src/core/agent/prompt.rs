//! System prompt assembly for the agent (stable prefix + variable tail).
//!
//! Ported from the TypeScript `atomic-agent` prompt layer
//! (`stable-prefix.ts` + `build-prompt.ts`). The prompt is a **stable
//! prefix** — persona + `### rules` + `### skills` + `### tools` + `### capabilities` +
//! `### instructions` — that must stay byte-identical within a session so
//! `llama-server`'s `cache_prompt` + `slot_id` KV-cache reuse holds, followed
//! by a **variable tail** (optional `### loaded-tools` and
//! `### loaded-skills`, `### conversation`, optional `### notice`, and the
//! `### respond` emit anchor).
//!
//! Iteration 1 hardcodes a fixed tool set (see [`ITERATION_ONE_TOOLS`]) — no
//! `browser` / `memory` / `tasks` / `mcp` tools — so the
//! grammar and descriptors are static.

use std::path::{Path, PathBuf};

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillDescriptor {
    pub name: String,
    pub description: String,
    pub version: String,
    pub requires_tools: Vec<String>,
    pub requires_scripts: Vec<String>,
    pub dangerous: bool,
}

const MAX_SKILLS_CATALOG_CHARS: usize = 16_000;

fn format_skill(descriptor: &SkillDescriptor) -> String {
    let mut qualifiers = Vec::new();
    if !descriptor.requires_tools.is_empty() {
        qualifiers.push(format!("tools={}", descriptor.requires_tools.join(",")));
    }
    if !descriptor.requires_scripts.is_empty() {
        qualifiers.push(format!("scripts={}", descriptor.requires_scripts.join(",")));
    }
    if descriptor.dangerous {
        qualifiers.push("dangerous".to_owned());
    }
    let suffix = if qualifiers.is_empty() {
        String::new()
    } else {
        format!(" [{}]", qualifiers.join("; "))
    };
    format!(
        "- {} (v{}): {}{}",
        descriptor.name, descriptor.version, descriptor.description, suffix
    )
}

fn render_skills_catalog(descriptors: &[SkillDescriptor]) -> String {
    if descriptors.is_empty() {
        return "(none)".to_owned();
    }
    let mut rendered = String::new();
    let mut rendered_count = 0;
    for descriptor in descriptors {
        let line = format_skill(descriptor);
        let separator_chars = usize::from(!rendered.is_empty());
        if rendered.chars().count() + separator_chars + line.chars().count()
            > MAX_SKILLS_CATALOG_CHARS
        {
            break;
        }
        if !rendered.is_empty() {
            rendered.push('\n');
        }
        rendered.push_str(&line);
        rendered_count += 1;
    }
    let omitted = descriptors.len().saturating_sub(rendered_count);
    if omitted > 0 {
        rendered.push_str(&format!("\n... [{omitted} skills omitted]"));
    }
    rendered
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
    "- Batch only independent calls. Approval-gated tools and calls that depend on another call's result must use a length-1 array. A terminal verb may appear only once and only last.",
    "- Be decisive. Do not narrate what you are about to do in prose — call the tool. Do not ask for confirmation unless a tool is approval-gated.",
    "- When the task is complete, call `reply` with the final answer. Only call `finish` if the user explicitly asked to end the session.",
    "- Keep `reply` short and to the point. If the user asked for an exact value or marker, `reply.text` must be ONLY that bare value — no preamble, no restating the question, no extra commentary or markdown before or after.",
    "- Respect the loop guard. If you are told a call was denied as a loop, change your approach — do not repeat the same call.",
    "- Rare tools are listed without argument schemas. Call `tool.view { name }` before using a rare tool whose exact arguments are not already loaded.",
    "- Skills are listed as summaries. Call `skill.view { name }` before applying a skill whose full instructions are not already under `### loaded-skills`.",
    "- `skill.run_script.script` is only an exact bundled filename listed as `scripts=` for that skill; put its arguments in `args`. Never put a shell command or external CLI invocation in `script`. Skills without `scripts=` must use their declared tools, typically `os.shell.run { cmd, args }` for external CLIs.",
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
        name: "tool.view",
        summary: "Load the full descriptor and args schema for a rare tool into the variable prompt tail.",
        args_schema: r#"{ name: string }"#,
        tier: ToolTier::Frequent,
        examples: &[],
    },
    ToolDescriptor {
        name: "skill.view",
        summary: "Load one enabled skill's full SKILL.md body into the variable prompt tail.",
        args_schema: r#"{ name: string }"#,
        tier: ToolTier::Frequent,
        examples: &[],
    },
    ToolDescriptor {
        name: "skill.run_script",
        summary: "Run an exact bundled script filename declared under the skill's scripts= catalog entry; never a shell command. Always approval-gated.",
        args_schema: r#"{ skill: string, script: string, args?: string[], timeout_ms?: number }"#,
        tier: ToolTier::Frequent,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.shell.run",
        summary: "Run a shell command. Direct-exec by default; routes through a subshell when the command needs shell interpretation. Approval-gated. Prefer a dedicated fs/git tool when one exists.",
        args_schema: r#"{ cmd: string, args?: string[], cwd?: string, timeoutMs?: number }"#,
        tier: ToolTier::Frequent,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.fs.read",
        summary: "Read a UTF-8 text file using an optional byte offset and byte limit.",
        args_schema: r#"{ path: string, offset?: number, limit?: number }"#,
        tier: ToolTier::Frequent,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.fs.write",
        summary: "Write or append text to a file, creating parent directories. Empty content is valid and creates or truncates a file. Approval-gated.",
        args_schema: r#"{ path: string, content: string, mode?: "replace" | "append" }"#,
        tier: ToolTier::Frequent,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.fs.mkdir",
        summary: "Create an empty directory without adding placeholder files. Parent directories are created by default. Approval-gated.",
        args_schema: r#"{ path: string, recursive?: boolean }"#,
        tier: ToolTier::Frequent,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.fs.trash",
        summary: "Move exact files/directories to the OS trash (recoverable). First find exact matches with os.fs.list/os.fs.glob and pass those paths. Never replace matched children with their parent directory or use shell deletion as fallback. Approval-gated.",
        args_schema: r#"{ paths: string[] } // 1..500 exact paths"#,
        tier: ToolTier::Frequent,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.fs.list",
        summary: "List one directory non-recursively, sorted by entry type and name.",
        args_schema: r#"{ path?: string }"#,
        tier: ToolTier::Frequent,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.fs.glob",
        summary: "Find files by glob pattern (e.g. src/**/*.ts). Read-only.",
        args_schema: r#"{ pattern: string, cwd?: string }"#,
        tier: ToolTier::Frequent,
        examples: &[],
    },
    ToolDescriptor {
            name: "os.fs.grep",
            summary: "Recursively search UTF-8 text files with a regex, respecting standard ignore files and skipping symlink traversal. Returns path:line:text matches, skips binary/non-UTF-8/oversized (>1 MiB) files during directory searches, and caps output at 16K characters. Read-only.",
            args_schema: r#"{ pattern: string, path?: string }"#,
        tier: ToolTier::Frequent,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.fs.edit",
        summary: "Replace a string in a UTF-8 text file (old -> new, must be unique unless replaceAll). Approval-gated.",
        args_schema: r#"{ path: string, oldString: string, newString: string, replaceAll?: boolean }"#,
        tier: ToolTier::Frequent,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.fs.read_document",
        summary: "Extract bounded plain text from PDF, DOCX, XLS/XLSX/ODS, PPTX, CSV, HTML, Markdown, source-code, and text files. Scanned PDFs require OCR and are unsupported. Read-only.",
        args_schema: r#"{ path: string, maxChars?: number }"#,
        tier: ToolTier::Frequent,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.fs.archive.list",
        summary: "List entries in a zip, tar, tar.gz, or tgz archive without extracting. Read-only.",
        args_schema: r#"{ path: string }"#,
        tier: ToolTier::Rare,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.fs.archive.read_entry",
        summary: "Read a single entry from an archive as text. Read-only.",
        args_schema: r#"{ path: string, entry: string }"#,
        tier: ToolTier::Rare,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.fs.archive.extract",
        summary: "Safely extract a zip, tar, tar.gz, or tgz archive with traversal, special-entry, and expanded-size guards. Existing outputs are rejected unless overwrite=true. Approval-gated.",
        args_schema: r#"{ path: string, destination: string, overwrite?: boolean }"#,
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
            summary: "Create a bounded unified diff between two UTF-8 text files. Binary, non-UTF-8, and oversized (>1 MiB) files are rejected. Read-only.",
            args_schema: r#"{ pathA: string, pathB: string }"#,
        tier: ToolTier::Rare,
        examples: &[],
    },
    ToolDescriptor {
            name: "os.fs.patch",
            summary: "Validate or apply a multi-file unified diff to UTF-8 text files. Validation is the default; apply=true validates every file before writing and rolls back completed writes on failure. Binary, non-UTF-8, and oversized (>1 MiB) files are rejected. Approval-gated.",
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
        summary: "List running processes sorted by pid. Optional filter matches the process name. Read-only.",
        args_schema: r#"{ filter?: string, maxEntries?: number }"#,
        tier: ToolTier::Frequent,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.proc.kill",
        summary: "Terminate one positive process id. Approval-gated. SIGKILL is forceful; other supported signals request graceful termination where the platform permits.",
        args_schema: r#"{ pid: number, signal?: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP" }"#,
        tier: ToolTier::Frequent,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.http.request",
        summary: "Make a bounded HTTP request to a public http/https URL. Blocks private/local addresses but does not use a host allowlist. Approval-gated. Use for raw API/JSON or non-GET; for reading a web page use os.web.fetch.",
        args_schema: r#"{ url: string, method?: string, headers?: Record<string, string>, body?: string, timeoutMs?: number }"#,
        tier: ToolTier::Frequent,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.web.search",
            summary: "Search the web through keyless hosted Exa, which returns structured titles, URLs, and extracted highlights. Automatically falls back to DuckDuckGo when Exa is unavailable. Read-only.",
        args_schema: r#"{ query: string, maxResults?: number }"#,
        tier: ToolTier::Frequent,
        examples: &[
            r#"{"query":"rust tokio oneshot channel example"}"#,
        ],
    },
    ToolDescriptor {
        name: "os.web.fetch",
            summary: "Read a web page as bounded markdown/text through keyless hosted Exa, including pages that reject simple HTTP clients. Automatically falls back to the existing SSRF-guarded direct GET/extractor. Read-only; for raw API/JSON or POST, use os.http.request.",
        args_schema: r#"{ url: string, extractMode?: "markdown" | "text", maxChars?: number }"#,
        tier: ToolTier::Frequent,
        examples: &[
            r#"{"url":"https://example.com/article"}"#,
            r#"{"url":"https://docs.example.com/guide","extractMode":"text","maxChars":20000}"#,
        ],
    },
    ToolDescriptor {
        name: "vision.describe",
        summary: "Describe up to four local images with the active vision-capable model. Read-only; supports PNG, JPEG, GIF, and WebP.",
        args_schema: r#"{ paths: string[], prompt: string }"#,
        tier: ToolTier::Frequent,
        examples: &[r#"{"paths":["/path/to/image.png"],"prompt":"Describe the visible UI and any text."}"#],
    },
    ToolDescriptor {
        name: "os.clipboard.read",
        summary: "Read the system clipboard as text.",
        args_schema: r#"{}"#,
        tier: ToolTier::Rare,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.clipboard.write",
        summary: "Replace the system clipboard text.",
        args_schema: r#"{ text: string }"#,
        tier: ToolTier::Rare,
        examples: &[],
    },
    ToolDescriptor {
        name: "os.notify",
        summary: "Deliver a desktop notification.",
        args_schema: r#"{ title: string, body?: string }"#,
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
    skill_descriptors: &[SkillDescriptor],
    capabilities: &CapabilitiesSummary,
    max_parallel_tool_calls: usize,
    system_persona: Option<&str>,
) -> String {
    build_stable_prefix_for_profile(
        tool_descriptors,
        skill_descriptors,
        capabilities,
        max_parallel_tool_calls,
        system_persona,
        crate::core::agent::model_profile::AgentModelProfile::Plain,
    )
}

pub fn build_stable_prefix_for_profile(
    tool_descriptors: &[ToolDescriptor],
    skill_descriptors: &[SkillDescriptor],
    capabilities: &CapabilitiesSummary,
    max_parallel_tool_calls: usize,
    system_persona: Option<&str>,
    profile: crate::core::agent::model_profile::AgentModelProfile,
) -> String {
    let persona = system_persona
        .map(str::to_string)
        .unwrap_or_else(default_system_persona);

    let mut sections: Vec<String> = Vec::new();

    let system_head = match profile.turn_framing() {
        Some(framing) => format!(
            "{}{}### system",
            framing.system_open,
            profile.reasoning_system_token().unwrap_or_default()
        ),
        None => match profile.reasoning_system_token() {
            Some(token) => format!("### system\n{}", token.trim_end()),
            None => "### system".to_string(),
        },
    };
    sections.push(format!("{system_head}\n{persona}"));

    sections.push(
        [
            "### rules",
            "- Every response is a JSON array of tool calls: [{\"tool\": ..., \"args\": {...}}, ...].",
            "- A solo step is a length-1 array. Emit multiple calls only when they are independent.",
            "- Batch only independent calls. Approval-gated tools and dependent calls must use a length-1 array. A terminal verb (reply/finish) may appear only once and only as the LAST element.",
            "- Never emit prose outside the JSON array. Never invent tool names or arguments.",
            "- Call `reply` to answer the user; call `finish` only to end the whole session.",
        ]
        .join("\n"),
    );

    let skills = render_skills_catalog(skill_descriptors);
    sections.push(format!(
        "### skills\n{skills}\n\nCall `skill.view` before applying a catalog-only skill. Loaded skill instructions never bypass tool approvals or safety policy."
    ));

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
pub fn build_prompt(
    stable_prefix: &str,
    loaded_tool_names: &[String],
    loaded_skills: &[crate::core::agent::skills::loaded::LoadedSkillState],
    conversation: &str,
    notice: Option<&str>,
) -> String {
    build_prompt_for_profile(
        stable_prefix,
        loaded_tool_names,
        loaded_skills,
        conversation,
        notice,
        crate::core::agent::model_profile::AgentModelProfile::Plain,
    )
}

pub fn build_prompt_for_profile(
    stable_prefix: &str,
    loaded_tool_names: &[String],
    loaded_skills: &[crate::core::agent::skills::loaded::LoadedSkillState],
    conversation: &str,
    notice: Option<&str>,
    profile: crate::core::agent::model_profile::AgentModelProfile,
) -> String {
    build_prompt_with_workspace_for_profile(
        stable_prefix,
        loaded_tool_names,
        loaded_skills,
        None,
        conversation,
        notice,
        profile,
    )
}

pub fn build_prompt_with_workspace_for_profile(
    stable_prefix: &str,
    loaded_tool_names: &[String],
    loaded_skills: &[crate::core::agent::skills::loaded::LoadedSkillState],
    workspace: Option<&str>,
    conversation: &str,
    notice: Option<&str>,
    profile: crate::core::agent::model_profile::AgentModelProfile,
) -> String {
    let mut tail: Vec<String> = Vec::new();

    if let Some(loaded_tools) = render_loaded_tools(loaded_tool_names) {
        tail.push("### loaded-tools".to_string());
        tail.push(loaded_tools);
        tail.push(String::new());
    }

    if let Some(skills) = crate::core::agent::skills::loaded::render_loaded_skills(loaded_skills) {
        tail.push("### loaded-skills".to_string());
        tail.push(skills);
        tail.push(String::new());
    }

    if let Some(workspace) = workspace.filter(|value| !value.is_empty()) {
        tail.push("### workspace".to_string());
        tail.push(workspace.to_string());
        tail.push(String::new());
    }

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
    if let Some(framing) = profile.turn_framing() {
        tail.push(String::new());
        tail.push(framing.turn_close.trim_end().to_string());
        tail.push(framing.assistant_open.trim_end().to_string());
        tail.push(String::new());
    }

    format!("{stable_prefix}\n{}", tail.join("\n"))
}

pub fn format_workspace(
    primary_root: &Path,
    editable_roots: &[PathBuf],
    read_only_roots: &[PathBuf],
) -> String {
    let mut lines = vec![
        format!("primary: {}", primary_root.display()),
        "Relative paths resolve against primary.".to_string(),
    ];
    let mut seen = std::collections::HashSet::new();
    let external = editable_roots
        .iter()
        .filter(|root| root.as_path() != primary_root)
        .filter(|root| seen.insert(root.as_path()))
        .collect::<Vec<_>>();
    let read_only = read_only_roots
        .iter()
        .filter(|root| root.as_path() != primary_root)
        .filter(|root| seen.insert(root.as_path()))
        .collect::<Vec<_>>();
    if external.is_empty() && read_only.is_empty() {
        lines.push("external: none".to_string());
    }
    if !external.is_empty() {
        lines.push("external (CAN EDIT; use explicit paths):".to_string());
        lines.extend(
            external
                .into_iter()
                .map(|root| format!("- {}", root.display())),
        );
    }
    if !read_only.is_empty() {
        lines.push("external (VIEW ONLY; use explicit paths):".to_string());
        lines.extend(
            read_only
                .into_iter()
                .map(|root| format!("- {}", root.display())),
        );
    }
    lines.push(
        "For an unknown folder, issue the real filesystem call so access can be requested; never claim access before it is granted."
            .to_string(),
    );
    lines.join("\n")
}

const LOADED_TOOLS_MAX_CHARS: usize = 8_000;

fn render_loaded_tools(names: &[String]) -> Option<String> {
    let mut rendered = String::new();
    for name in names {
        let Some(descriptor) = ITERATION_ONE_TOOLS
            .iter()
            .find(|descriptor| descriptor.name == name && descriptor.tier == ToolTier::Rare)
        else {
            continue;
        };
        let entry = format_tool_frequent(descriptor);
        let separator = usize::from(!rendered.is_empty());
        if rendered.len() + separator + entry.len() > LOADED_TOOLS_MAX_CHARS {
            if !rendered.is_empty() {
                rendered.push_str("\n[truncated]");
            }
            break;
        }
        if !rendered.is_empty() {
            rendered.push('\n');
        }
        rendered.push_str(&entry);
    }
    (!rendered.is_empty()).then_some(rendered)
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
            &[],
            &caps,
            DEFAULT_MAX_PARALLEL_TOOL_CALLS,
            None,
        );

        let system = prefix.find("### system").expect("### system");
        let rules = prefix.find("### rules").expect("### rules");
        let skills = prefix.find("### skills").expect("### skills");
        let tools = prefix.find("### tools").expect("### tools");
        let caps_idx = prefix.find("### capabilities").expect("### capabilities");
        let instructions = prefix.find("### instructions").expect("### instructions");

        assert!(prefix.starts_with("### system"));
        assert!(system < rules);
        assert!(rules < skills);
        assert!(skills < tools);
        assert!(tools < caps_idx);
        assert!(caps_idx < instructions);
    }

    #[test]
    fn stable_prefix_embeds_persona_first_line() {
        let caps = test_caps("linux");
        let prefix = build_stable_prefix(ITERATION_ONE_TOOLS, &[], &caps, 8, None);
        assert!(prefix.contains("You are a capable autonomous operator agent"));
    }

    #[test]
    fn tools_block_renders_frequent_and_rare_partitions() {
        let caps = test_caps("linux");
        let prefix = build_stable_prefix(ITERATION_ONE_TOOLS, &[], &caps, 8, None);

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
        let prefix = build_stable_prefix(ITERATION_ONE_TOOLS, &[], &caps, 8, None);
        assert!(prefix.contains("- reply {"));
        assert!(prefix.contains("- finish {"));
    }

    #[test]
    fn windows_hint_gated_on_platform() {
        let mac = build_stable_prefix(ITERATION_ONE_TOOLS, &[], &test_caps("darwin"), 8, None);
        assert!(!mac.contains("`cmd.exe` subshell"));

        let win = build_stable_prefix(ITERATION_ONE_TOOLS, &[], &test_caps("win32"), 8, None);
        assert!(win.contains("`cmd.exe` subshell"));
        assert!(win.contains("C:\\Users\\me\\file.txt"));
    }

    #[test]
    fn instructions_interpolate_parallel_cap() {
        let caps = test_caps("linux");
        let prefix = build_stable_prefix(ITERATION_ONE_TOOLS, &[], &caps, 4, None);
        assert!(prefix.contains("Emit at most 4 tool calls per step"));
    }

    #[test]
    fn build_prompt_appends_tail_with_conversation_and_anchor() {
        let caps = test_caps("linux");
        let prefix = build_stable_prefix(ITERATION_ONE_TOOLS, &[], &caps, 8, None);
        let full = build_prompt(&prefix, &[], &[], "USER: hello", None);

        assert!(full.starts_with(&prefix));
        assert!(full.contains("### conversation\nUSER: hello"));
        assert!(full.trim_end().ends_with("### respond\nRespond now."));
        assert!(!full.contains("### notice"));
    }

    #[test]
    fn gemma4_prompt_uses_native_turn_and_channel_framing() {
        let caps = test_caps("linux");
        let profile = crate::core::agent::model_profile::AgentModelProfile::Gemma4Think;
        let prefix =
            build_stable_prefix_for_profile(ITERATION_ONE_TOOLS, &[], &caps, 8, None, profile);
        let full = build_prompt_for_profile(&prefix, &[], &[], "USER: hello", None, profile);

        assert!(prefix.starts_with("<|turn>system\n<|think|>\n### system"));
        assert!(full.ends_with("<turn|>\n<|turn>model\n"));
        assert!(!full.ends_with("<|channel>thought\n"));
    }

    #[test]
    fn build_prompt_includes_notice_when_present() {
        let caps = test_caps("linux");
        let prefix = build_stable_prefix(ITERATION_ONE_TOOLS, &[], &caps, 8, None);
        let full = build_prompt(
            &prefix,
            &[],
            &[],
            "USER: hi",
            Some("You repeated os.fs.read 3 times."),
        );
        assert!(full.contains("### notice\nYou repeated os.fs.read 3 times."));

        let empty = build_prompt(&prefix, &[], &[], "USER: hi", Some(""));
        assert!(!empty.contains("### notice"));
    }

    #[test]
    fn workspace_tail_lists_primary_and_external_roots() {
        let primary = PathBuf::from("/tmp/project");
        let external = PathBuf::from("/tmp/Desktop");
        let read_only = PathBuf::from("/tmp/Downloads");
        let workspace = format_workspace(
            &primary,
            &[primary.clone(), external.clone(), external.clone()],
            std::slice::from_ref(&read_only),
        );
        let full = build_prompt_with_workspace_for_profile(
            "stable",
            &[],
            &[],
            Some(&workspace),
            "USER: create a file on Desktop",
            None,
            crate::core::agent::model_profile::AgentModelProfile::Plain,
        );

        assert!(full.contains("### workspace\nprimary: /tmp/project"));
        assert!(full.contains("Relative paths resolve against primary."));
        assert!(full.contains("external (CAN EDIT; use explicit paths):\n- /tmp/Desktop"));
        assert!(full.contains("external (VIEW ONLY; use explicit paths):\n- /tmp/Downloads"));
        assert!(full.contains("issue the real filesystem call so access can be requested"));
        assert_eq!(full.matches("- /tmp/Desktop").count(), 1);
    }

    #[test]
    fn loaded_rare_tools_render_only_in_variable_tail() {
        let caps = test_caps("linux");
        let prefix = build_stable_prefix(ITERATION_ONE_TOOLS, &[], &caps, 8, None);
        let loaded = vec!["os.fs.hash".to_string()];
        let full = build_prompt(&prefix, &loaded, &[], "USER: hi", None);
        assert!(full.contains("### loaded-tools\n- os.fs.hash { path: string, algorithm?:"));
        assert!(!prefix.contains("### loaded-tools"));
    }

    #[test]
    fn skills_catalog_is_stable_and_loaded_bodies_stay_in_the_tail() {
        let caps = test_caps("linux");
        let skills = vec![SkillDescriptor {
            name: "test-skill".into(),
            description: "Test instructions".into(),
            version: "1.2.3".into(),
            requires_tools: vec!["os.fs.read".into()],
            requires_scripts: vec!["inspect.sh".into()],
            dangerous: true,
        }];
        let prefix = build_stable_prefix(ITERATION_ONE_TOOLS, &skills, &caps, 8, None);
        assert!(prefix.contains(
            "- test-skill (v1.2.3): Test instructions [tools=os.fs.read; scripts=inspect.sh; dangerous]"
        ));
        assert!(prefix.contains(
            "`skill.run_script.script` is only an exact bundled filename listed as `scripts=`"
        ));
        assert!(!prefix.contains("\n### loaded-skills\n"));

        let loaded = vec![crate::core::agent::skills::loaded::LoadedSkillState {
            name: "test-skill".into(),
            version: "1.2.3".into(),
            body: "# Full instructions".into(),
            loaded_at: 1,
        }];
        let full = build_prompt(&prefix, &[], &loaded, "USER: hi", None);
        assert!(
            full.contains("### loaded-skills\n# skill: test-skill (v1.2.3)\n# Full instructions")
        );
    }

    #[test]
    fn skills_catalog_has_a_total_character_budget() {
        let descriptors = (0..100)
            .map(|index| SkillDescriptor {
                name: format!("skill-{index}"),
                description: "x".repeat(500),
                version: "1.0.0".into(),
                requires_tools: vec!["os.fs.read".into()],
                requires_scripts: Vec::new(),
                dangerous: false,
            })
            .collect::<Vec<_>>();

        let catalog = render_skills_catalog(&descriptors);
        assert!(catalog.contains("skills omitted]"));
        assert!(catalog.chars().count() <= MAX_SKILLS_CATALOG_CHARS + 32);
    }
}
