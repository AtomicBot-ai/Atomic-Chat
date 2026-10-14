//! Second opinion on a network fix, before the user is asked to approve it.
//!
//! A separate, single model call — not the agent that proposed the fix —
//! reads the computer's system map, the proposed call, the agent's stated
//! reason and the fix's blast radius, and answers `agree`, `concern` or
//! `disagree` with one short explanation. The verdict is shown on the
//! approval card; the user still decides. A review that cannot run (no model,
//! timeout, unreadable answer) says so instead of guessing, and never blocks
//! the approval.

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::blast_radius;
use crate::core::agent::llm_client::{AgentLlmClient, AgentPrompt, CompletionRequest};

const REVIEW_TIMEOUT: Duration = Duration::from_secs(45);
const REVIEW_MAX_TOKENS: u32 = 400;
const MAX_REASON_CHARS: usize = 400;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Agree,
    Concern,
    Disagree,
    /// The review could not be produced; `reason` says why.
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Review {
    pub verdict: Verdict,
    pub reason: String,
}

impl Review {
    fn unavailable(reason: impl Into<String>) -> Self {
        Self {
            verdict: Verdict::Unavailable,
            reason: reason.into(),
        }
    }
}

/// GBNF for llama.cpp: exactly `{"verdict": …, "reason": "…"}`.
const REVIEW_GRAMMAR: &str = r#"root ::= "{" ws "\"verdict\"" ws ":" ws verdict ws "," ws "\"reason\"" ws ":" ws string ws "}"
verdict ::= "\"agree\"" | "\"concern\"" | "\"disagree\""
string ::= "\"" char* "\""
char ::= [^"\\\x00-\x1f] | "\\" ["\\/bfnrt]
ws ::= [ \t\n\r]*
"#;

fn review_schema() -> Value {
    json!({
        "type": "json_schema",
        "json_schema": {
            "name": "fix_review",
            "strict": true,
            "schema": {
                "type": "object",
                "properties": {
                    "verdict": {"type": "string", "enum": ["agree", "concern", "disagree"]},
                    "reason": {"type": "string"}
                },
                "required": ["verdict", "reason"],
                "additionalProperties": false
            }
        }
    })
}

/// The reviewer's instructions and the case it is reviewing.
pub fn review_prompt(system_map: &str, tool: &str, args: &Value) -> AgentPrompt {
    let reason = args
        .get("reason")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|reason| !reason.is_empty())
        .unwrap_or("(the agent gave no reason)");
    let mut shown_args = args.clone();
    if let Some(object) = shown_args.as_object_mut() {
        object.remove("reason");
    }
    let radius = blast_radius(tool, args)
        .map(|radius| radius.to_markdown())
        .unwrap_or_else(|| "(none)".into());
    let system = "You are a cautious network engineer giving a second opinion on a change \
another assistant wants to make to this computer. You did not propose it. Judge only from \
the system map and the facts below.\n\
Answer \"agree\" when the change fits the problem and the computer, \"concern\" when it may \
work but has a real risk or a smaller fix should come first, and \"disagree\" when it targets \
the wrong adapter, does not match the diagnosis, cannot work on this computer, or is \
disproportionate. Give one or two plain sentences in \"reason\" that a non-expert can act on. \
Reply with the JSON object only.";
    let body = format!(
        "## System map\n{map}\n\n## Proposed change\nTool: {tool}\nArguments: {args}\n\
         Agent's reason: {reason}\n\n## Blast radius\n{radius}\n\nYour verdict as JSON:",
        map = system_map.trim(),
        args = serde_json::to_string(&shown_args).unwrap_or_default(),
    );
    AgentPrompt::parts(system, body)
}

/// Read a verdict out of the model's answer, tolerating text around the
/// JSON object (chat transports without schema support).
pub fn parse_review(content: &str) -> Option<Review> {
    let start = content.find('{')?;
    let end = content.rfind('}')?;
    let value: Value = serde_json::from_str(content.get(start..=end)?).ok()?;
    let verdict = match value
        .get("verdict")?
        .as_str()?
        .trim()
        .to_lowercase()
        .as_str()
    {
        "agree" => Verdict::Agree,
        "concern" => Verdict::Concern,
        "disagree" => Verdict::Disagree,
        _ => return None,
    };
    let reason: String = value
        .get("reason")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .chars()
        .take(MAX_REASON_CHARS)
        .collect();
    Some(Review { verdict, reason })
}

/// Ask the model for a verdict on `tool(args)` against `system_map`.
pub async fn review_with_map(
    client: &dyn AgentLlmClient,
    system_map: &str,
    tool: &str,
    args: &Value,
    cancellation: &CancellationToken,
) -> Review {
    let capabilities = client.capabilities();
    let mut request =
        CompletionRequest::oneshot(review_prompt(system_map, tool, args), REVIEW_MAX_TOKENS);
    if capabilities.grammar {
        request.grammar = Some(REVIEW_GRAMMAR.to_owned());
    }
    if capabilities.json_schema {
        request.response_schema = Some(Arc::new(review_schema()));
    }
    let completion = tokio::select! {
        _ = cancellation.cancelled() => return Review::unavailable("The review was cancelled."),
        result = tokio::time::timeout(REVIEW_TIMEOUT, client.complete(&request, cancellation)) => result,
    };
    match completion {
        Err(_) => Review::unavailable(format!(
            "The reviewer did not answer within {}s.",
            REVIEW_TIMEOUT.as_secs()
        )),
        Ok(Err(error)) => Review::unavailable(format!("The reviewer could not run: {error}")),
        Ok(Ok(result)) => parse_review(&result.content)
            .unwrap_or_else(|| Review::unavailable("The reviewer's answer could not be read.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::agent::test_support::{ScriptedCompletionServer, ScriptedResponse};

    const MAP: &str = "# System map\n## Network adapters\n- **Wi-Fi**: IPv4 192.0.2.20; gateway 192.0.2.1; DNS 192.0.2.1\n";

    #[test]
    fn the_prompt_carries_the_map_the_change_its_reason_and_blast_radius() {
        let prompt = review_prompt(
            MAP,
            "net.set_dns",
            &json!({"adapter": "Wi-Fi", "servers": ["1.1.1.1"], "reason": "DNS lookups time out"}),
        );
        let body = prompt.body;
        assert!(body.contains("**Wi-Fi**"));
        assert!(body.contains("Tool: net.set_dns"));
        assert!(body.contains("\"servers\":[\"1.1.1.1\"]"));
        assert!(body.contains("Agent's reason: DNS lookups time out"));
        assert!(body.contains("Change the DNS servers of Wi-Fi to 1.1.1.1."));
        // The reason is shown once, as the reason — not echoed in the args.
        assert!(!body.contains("\"reason\""));
        assert!(prompt.system.unwrap().contains("second opinion"));
    }

    #[test]
    fn verdicts_are_read_strictly_and_tolerantly() {
        assert_eq!(
            parse_review(r#"{"verdict":"concern","reason":"Try flushing DNS first."}"#),
            Some(Review {
                verdict: Verdict::Concern,
                reason: "Try flushing DNS first.".into()
            })
        );
        let wrapped = "Sure.\n{\"verdict\": \"DISAGREE\", \"reason\": \"Wrong adapter.\"}\nDone.";
        assert_eq!(parse_review(wrapped).unwrap().verdict, Verdict::Disagree);
        assert_eq!(parse_review(r#"{"verdict":"maybe","reason":"x"}"#), None);
        assert_eq!(parse_review("no json here"), None);
    }

    #[tokio::test]
    async fn a_review_comes_from_its_own_model_call() {
        let server = ScriptedCompletionServer::start(vec![ScriptedResponse::completion(
            r#"{"verdict":"disagree","reason":"Ethernet is disconnected; the active adapter is Wi-Fi."}"#,
        )])
        .await;
        let client = server.client();
        let review = review_with_map(
            &client,
            MAP,
            "net.adapter_restart",
            &json!({"adapter": "Ethernet", "reason": "slow internet"}),
            &CancellationToken::new(),
        )
        .await;
        assert_eq!(review.verdict, Verdict::Disagree);
        assert!(review.reason.contains("active adapter is Wi-Fi"));
        let request = &server.requests()[0];
        assert!(request["prompt"]
            .as_str()
            .unwrap()
            .contains("Tool: net.adapter_restart"));
        // llama.cpp transport: the answer is grammar-constrained.
        assert!(request["grammar"]
            .as_str()
            .unwrap()
            .contains("\"\\\"disagree\\\"\""));
    }

    #[tokio::test]
    async fn an_unreadable_answer_is_reported_not_guessed() {
        let server = ScriptedCompletionServer::start(vec![ScriptedResponse::completion(
            "I think it is probably fine",
        )])
        .await;
        let client = server.client();
        let review = review_with_map(
            &client,
            MAP,
            "net.dns_flush",
            &json!({}),
            &CancellationToken::new(),
        )
        .await;
        assert_eq!(review.verdict, Verdict::Unavailable);
    }
}
