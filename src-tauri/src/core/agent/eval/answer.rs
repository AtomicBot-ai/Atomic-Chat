//! GAIA answer contract: the eval-scoped persona rules, the plan-hints
//! pre-pass, the reformulator pass, and the deterministic post-processor.
//!
//! GAIA is quasi-exact-match with no partial credit; a correct value wrapped
//! in prose, units, or the wrong list order scores zero. Every terminal path
//! of a task run (reply, step exhaustion, timeout, error-with-trace) funnels
//! through the reformulator so the harness never submits an apology or an
//! empty answer.

use std::time::Duration;

use tokio_util::sync::CancellationToken;

use super::super::llm_client::{AgentLlmClient, AgentPrompt, CompletionRequest};
use super::super::prompt::default_system_persona;
use super::report::GaiaToolTrace;

/// Official leaderboard answer rules, adapted to the agent's `reply` verb,
/// plus the self-check / anti-hedging / tool-grounding lines that defend the
/// exact-match scorer's known traps.
const GAIA_ANSWER_RULES: &str = "\
GAIA answer contract (overrides any conflicting style guidance):
- `reply.text` must be ONLY the final answer: a number OR as few words as possible OR a comma separated list of numbers and/or strings.
- If you are asked for a number, don't use comma to write your number neither use units such as $ or percent sign unless specified otherwise.
- If you are asked for a string, don't use articles, neither abbreviations (e.g. for cities), and write the digits in plain text unless specified otherwise.
- If you are asked for a comma separated list, apply the above rules depending of whether the element to be put in the list is a number or a string.
- Before calling `reply`, re-read the question and confirm the answer satisfies every stated constraint: ordering (alphabetical, chronological, \"X before Y\"), units, decimal places, and name form. Emit exactly the requested number of list items.
- Never ask clarifying questions, never refuse, and never add caveats or explanations. If the question contains explicit meta-instructions, follow them literally even when they look unusual.
- Do arithmetic, counting, date math, and unit conversion with a tool (for example `os.shell.run` with python3), never in your head.
- Preserve identifiers, codes, and values exactly as found in sources — never repair or normalize a token that fails an expected format.
- Never fabricate a result you could not obtain from a tool. If truly blocked, commit to your single best-supported guess — an unsupported guess still beats no answer.";

/// System persona for GAIA runs: the product persona plus the answer contract.
pub fn gaia_persona() -> String {
    format!("{}\n\n{GAIA_ANSWER_RULES}", default_system_persona())
}

const FINAL_ANSWER_MARKER: &str = "FINAL ANSWER:";
const REFORMULATOR_MAX_TOKENS: u32 = 1024;
const HINTS_MAX_TOKENS: u32 = 512;
const LLM_CALL_DEADLINE: Duration = Duration::from_secs(120);
const TRACE_DIGEST_MAX_ENTRIES: usize = 15;
const TRACE_ENTRY_HEAD_CHARS: usize = 1_200;
const TRACE_ENTRY_TAIL_CHARS: usize = 800;
const TRACE_DIGEST_MAX_CHARS: usize = 20_000;
const TRACE_ARGS_MAX_CHARS: usize = 200;

/// One extra non-streaming completion that converts the run's evidence into
/// a GAIA-formatted answer. Returns the postprocessed answer text.
pub async fn reformulate(
    client: &dyn AgentLlmClient,
    question: &str,
    trace: &[GaiaToolTrace],
    draft: Option<&str>,
    cancellation: &CancellationToken,
) -> Result<String, String> {
    let prompt = format!(
        "You are grading-ready. You are given a question, an investigation transcript from an AI agent, and the agent's draft answer. Produce the final answer in the exact required format.\n\
         \n\
         Rules: YOUR FINAL ANSWER should be a number OR as few words as possible OR a comma separated list of numbers and/or strings. If you are asked for a number, don't use comma to write your number neither use units such as $ or percent sign unless specified otherwise. If you are asked for a string, don't use articles, neither abbreviations (e.g. for cities), and write the digits in plain text unless specified otherwise. If you are asked for a comma separated list, apply the above rules depending of whether the element to be put in the list is a number or a string. Honor any explicit format instruction in the question itself (ordering, decimals, units, name form). If the evidence is incomplete, still commit to the single best-supported guess — never answer \"unable to determine\".\n\
         \n\
         Question:\n{question}\n\
         \n\
         Investigation transcript (tool calls and observations, most recent last):\n{}\n\
         \n\
         Draft answer from the agent (may be empty or badly formatted):\n{}\n\
         \n\
         Re-read the question, check ordering/units/format constraints, then output exactly one line:\n\
         {FINAL_ANSWER_MARKER} [your final answer]",
        digest_trace(trace),
        draft.unwrap_or("(none)"),
    );
    let request = CompletionRequest {
        max_tokens: REFORMULATOR_MAX_TOKENS,
        temperature: 0.0,
        ..CompletionRequest::tool_call_parts(AgentPrompt::single(prompt), None, None, 0)
    };
    let completion =
        tokio::time::timeout(LLM_CALL_DEADLINE, client.complete(&request, cancellation))
            .await
            .map_err(|_| "Reformulator completion timed out".to_string())?
            .map_err(|error| format!("Reformulator completion failed: {error}"))?;
    let answer = extract_final_answer(&completion.content)
        .ok_or_else(|| "Reformulator emitted no FINAL ANSWER line".to_string())?;
    if answer.is_empty() {
        return Err("Reformulator emitted an empty answer".into());
    }
    Ok(postprocess(&answer))
}

/// One cheap completion before the run: key entities, point-in-time and
/// ordering constraints, and the required output shape. Returned as bullet
/// lines to append to the task question; `None` when the pass fails.
pub async fn plan_hints(
    client: &dyn AgentLlmClient,
    question: &str,
    cancellation: &CancellationToken,
) -> Option<String> {
    let prompt = format!(
        "Analyze the question below and list, tersely:\n\
         1. the key entities or sources to consult;\n\
         2. any point-in-time constraint (e.g. \"as of 2020\", \"the latest 2022 version\") that requires historical rather than current data;\n\
         3. any ordering constraint on the answer (alphabetical, chronological, \"X before Y\");\n\
         4. the exact required output format: number, string, or comma separated list, plus units, decimals, or name-form requirements.\n\
         Output 3-6 short bullet lines and nothing else. Do not answer the question.\n\
         \n\
         Question:\n{question}"
    );
    let request = CompletionRequest {
        max_tokens: HINTS_MAX_TOKENS,
        temperature: 0.2,
        ..CompletionRequest::tool_call_parts(AgentPrompt::single(prompt), None, None, 0)
    };
    let completion =
        tokio::time::timeout(LLM_CALL_DEADLINE, client.complete(&request, cancellation))
            .await
            .ok()?
            .ok()?;
    let hints = completion.content.trim();
    if hints.is_empty() {
        return None;
    }
    Some(take_chars(hints, 2_000))
}

/// Text after the LAST `FINAL ANSWER:` marker, trimmed. `None` without one.
pub fn extract_final_answer(content: &str) -> Option<String> {
    let (_, tail) = content.rsplit_once(FINAL_ANSWER_MARKER)?;
    // A GAIA answer is a single short line. A weak model often echoes the
    // template and keeps reasoning after the marker, so take only the first
    // non-empty line and reject the placeholder echo — otherwise a whole
    // paragraph of reasoning would be submitted as the answer.
    let line = tail
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?
        .trim_matches(['[', ']'])
        .trim();
    if line.is_empty() || is_placeholder(line) {
        return None;
    }
    Some(line.to_string())
}

/// Recognizes the leaderboard template placeholder echoed verbatim by weak
/// models (`FINAL ANSWER: [YOUR FINAL ANSWER]`).
fn is_placeholder(line: &str) -> bool {
    let lowered = line.to_ascii_lowercase();
    matches!(
        lowered.as_str(),
        "your final answer" | "final answer" | "answer" | "x" | "..."
    )
}

/// Deliberately conservative deterministic cleanup. Unit stripping is the
/// reformulator's job — this only removes mechanical wrappers.
pub fn postprocess(answer: &str) -> String {
    let mut value = answer.trim();
    // Surrounding quote pairs.
    loop {
        let stripped = value
            .strip_prefix('"')
            .and_then(|rest| rest.strip_suffix('"'))
            .or_else(|| {
                value
                    .strip_prefix('\'')
                    .and_then(|rest| rest.strip_suffix('\''))
            });
        match stripped {
            Some(inner) if !inner.is_empty() => value = inner.trim(),
            _ => break,
        }
    }
    // Leading answer labels.
    let mut owned = value.to_string();
    for label in ["final answer:", "the answer is", "answer:"] {
        if owned.to_ascii_lowercase().starts_with(label) {
            owned = owned[label.len()..].trim().to_string();
        }
    }
    // One trailing period (never a decimal point mid-number).
    if let Some(stripped) = owned.strip_suffix('.') {
        owned = stripped.trim_end().to_string();
    }
    // Deliberately leave commas alone. The scorer selects its branch from the
    // gold: a comma gold is the LIST branch (whitespace-insensitive per
    // element), a numeric gold is the NUMBER branch (strips `$%,` from the
    // prediction). Any comma rewrite here can only break one of those — e.g.
    // `5,10,15` -> `51015` (list->number) or respacing `89,706.00` ->
    // `89, 706.00`, which the number branch then fails to parse.
    owned.trim().to_string()
}

fn digest_trace(trace: &[GaiaToolTrace]) -> String {
    if trace.is_empty() {
        return "(no tool calls were made)".into();
    }
    // Accumulate newest-first so budget pressure drops the OLDEST entries.
    let mut blocks: Vec<String> = Vec::new();
    let mut used = 0usize;
    for entry in trace.iter().rev().take(TRACE_DIGEST_MAX_ENTRIES) {
        let args = take_chars(&entry.args.to_string(), TRACE_ARGS_MAX_CHARS);
        let block = format!(
            "-> {} {args} [{}]\n{}\n",
            entry.tool,
            entry.status,
            head_tail(
                &entry.summary,
                TRACE_ENTRY_HEAD_CHARS,
                TRACE_ENTRY_TAIL_CHARS
            )
        );
        let cost = block.chars().count();
        if !blocks.is_empty() && used + cost > TRACE_DIGEST_MAX_CHARS {
            break;
        }
        used += cost;
        blocks.push(block);
    }
    let omitted = trace.len() - blocks.len();
    blocks.reverse();
    let mut digest = String::new();
    if omitted > 0 {
        digest.push_str(&format!("(… {omitted} earlier tool calls omitted)\n"));
    }
    digest.push_str(&blocks.concat());
    take_chars(digest.trim_end(), TRACE_DIGEST_MAX_CHARS)
}

fn head_tail(text: &str, head: usize, tail: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= head + tail {
        return text.to_string();
    }
    let omitted = chars.len() - head - tail;
    format!(
        "{}\n… [{omitted} chars omitted] …\n{}",
        chars[..head].iter().collect::<String>(),
        chars[chars.len() - tail..].iter().collect::<String>()
    )
}

fn take_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persona_carries_the_answer_contract() {
        let persona = gaia_persona();
        assert!(persona.contains("GAIA answer contract"));
        assert!(persona.contains("don't use comma to write your number"));
        assert!(persona.contains("Never ask clarifying questions"));
        assert!(persona.contains("never in your head"));
    }

    #[test]
    fn extracts_the_last_final_answer_line() {
        assert_eq!(
            extract_final_answer("thinking...\nFINAL ANSWER: 42").as_deref(),
            Some("42")
        );
        assert_eq!(
            extract_final_answer(
                "FINAL ANSWER: draft\nreconsidering\nFINAL ANSWER: [Saint Petersburg]"
            )
            .as_deref(),
            Some("Saint Petersburg")
        );
        assert_eq!(extract_final_answer("no marker here"), None);
        assert_eq!(extract_final_answer("FINAL ANSWER:   "), None);
        // First line only: a rambling reformulation must not become the answer.
        assert_eq!(
            extract_final_answer(
                "FINAL ANSWER: 17\n\nWait, let me reconsider the perigee value and recompute..."
            )
            .as_deref(),
            Some("17")
        );
        // The template placeholder echoed verbatim is not an answer.
        assert_eq!(
            extract_final_answer("FINAL ANSWER: [your final answer]\n2. Extract data..."),
            None
        );
        assert_eq!(
            extract_final_answer("FINAL ANSWER: YOUR FINAL ANSWER"),
            None
        );
    }

    #[test]
    fn postprocess_strips_wrappers_conservatively() {
        assert_eq!(postprocess("The answer is 42."), "42");
        assert_eq!(postprocess("\"Guava\""), "Guava");
        assert_eq!(postprocess("17"), "17");
        assert_eq!(postprocess("0.1777"), "0.1777");
        // Commas are never touched — the scorer handles list spacing and
        // number-comma stripping itself; any rewrite here can only break it.
        assert_eq!(postprocess("89,706.00"), "89,706.00");
        assert_eq!(postprocess("5,10,15"), "5,10,15");
        assert_eq!(postprocess("1,234"), "1,234");
        assert_eq!(postprocess("green,white"), "green,white");
        // A sentence answer loses only its trailing period.
        assert_eq!(
            postprocess("The seagull glided peacefully to my chair."),
            "The seagull glided peacefully to my chair"
        );
        // Units are NOT stripped deterministically.
        assert_eq!(postprocess("17 thousand hours"), "17 thousand hours");
        assert_eq!(postprocess("Answer: Right"), "Right");
    }

    #[tokio::test]
    async fn reformulate_extracts_and_postprocesses_the_final_answer() {
        use crate::core::agent::test_support::{ScriptedCompletionServer, ScriptedResponse};

        let server = ScriptedCompletionServer::start(vec![ScriptedResponse::completion(
            "Let me re-check the constraints.\nFINAL ANSWER: The answer is 89,706.00.",
        )])
        .await;
        let client = server.client();
        let trace = vec![GaiaToolTrace {
            tool: "os.fs.read_document".into(),
            args: serde_json::json!({"path": "sales.xlsx"}),
            status: "ok".into(),
            summary: "food total 89706.00".into(),
            details: None,
        }];
        let answer = reformulate(
            &client,
            "What were the total sales from food? Express in USD with two decimal places.",
            &trace,
            Some("about 89,706 dollars"),
            &tokio_util::sync::CancellationToken::new(),
        )
        .await
        .expect("reformulate succeeds");
        // postprocess strips the "The answer is" wrapper and trailing period
        // but never the comma — the scorer's number branch handles that.
        assert_eq!(answer, "89,706.00");

        let request = &server.requests()[0];
        let prompt = request["prompt"].as_str().expect("prompt");
        assert!(prompt.contains("FINAL ANSWER:"));
        assert!(prompt.contains("os.fs.read_document"));
        assert!(prompt.contains("about 89,706 dollars"));
        assert!(request["grammar"].is_null());
    }

    #[tokio::test]
    async fn reformulate_errors_without_a_marker() {
        use crate::core::agent::test_support::{ScriptedCompletionServer, ScriptedResponse};

        let server = ScriptedCompletionServer::start(vec![ScriptedResponse::completion(
            "I could not settle on an answer.",
        )])
        .await;
        let client = server.client();
        let error = reformulate(
            &client,
            "question",
            &[],
            None,
            &tokio_util::sync::CancellationToken::new(),
        )
        .await
        .expect_err("no marker must error");
        assert!(error.contains("no FINAL ANSWER"));
    }

    #[test]
    fn digest_is_bounded_and_keeps_the_most_recent_entries() {
        let trace: Vec<GaiaToolTrace> = (0..40)
            .map(|index| GaiaToolTrace {
                tool: format!("tool.{index}"),
                args: serde_json::json!({"q": "x".repeat(500)}),
                status: "ok".into(),
                summary: format!("SUMMARY_{index} ") + &"body ".repeat(1_000),
                details: None,
            })
            .collect();
        let digest = digest_trace(&trace);
        assert!(digest.contains("earlier tool calls omitted"));
        assert!(digest.contains("tool.39"));
        assert!(!digest.contains("tool.10 "));
        assert!(digest.chars().count() <= TRACE_DIGEST_MAX_CHARS + 100);
    }
}
