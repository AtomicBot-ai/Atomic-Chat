---
date: 2026-08-24
title: "GAIA L1: answer contract, reformulator, and harness sampling"
---

# 2026-08-24 — GAIA L1: answer contract, reformulator, and harness sampling

- **Context:** GAIA is quasi-exact-match with no partial credit; measured
  studies attribute ~8% of top-agent failures to correct answers in the wrong
  shape, and the largest L1 levers are answer formatting, best-of-N sampling,
  and plan hints. The eval harness previously appended one instruction, scored
  the raw reply, submitted nothing on timeout/step-exhaustion, and ran each task
  once. This records the harness/answer changes (AGENTS.md §6 rule 8).
- **Decision:**
  - **Answer contract**: GAIA runs use an eval-scoped persona
    (`eval/answer.rs::gaia_persona`) carrying the official leaderboard answer
    rules plus a self-check, an anti-hedging clause (never ask/refuse/caveat;
    obey literal meta-instructions), and a mandatory-tool-use line (compute with
    a tool, never in the head). This is eval-only; the product persona is
    unchanged.
  - **Reformulator + forced guess**: every terminal path (reply, step
    exhaustion, timeout, error-with-trace) runs one non-streaming completion
    that converts the question + tool trace into a `FINAL ANSWER:` line, so the
    harness never submits an apology or an empty answer. A `postprocess` step
    strips only mechanical wrappers (quotes, "The answer is", one trailing
    period) and **never touches commas** — the scorer's own branch handles list
    spacing and number-comma stripping, and any rewrite there breaks one of them.
  - **Scoring parity + diagnostics**: `scoring.rs` mirrors the official
    `scorer.py` branch gate (a comma in the gold is the list branch, never a
    thousands separator) and reports the branch, normalized forms, and the raw
    (pre-reformulator) prediction and its score, separating formatting failures
    from reasoning failures.
  - **Best-of-N + reasoning flag**: `--samples N` runs N independent samples per
    task and majority-votes on a normalized key that matches the scorer's branch
    semantics; per-sample results are recorded for variance. `--reasoning
    unset|off|low|medium|high|xhigh` maps to the existing llama.cpp thinking
    budgets. Both default to the prior single-run, thinking-unset behavior.
  - **Skills activated in eval**: `make gaia-eval` now defaults
    `GAIA_SKILLS_DIR` to the bundled skills, and the eval approval hook allows
    http(s) URL resources and files under the skills dir, so `os.http.request`
    and `skill.run_script` (whisper/ocrmypdf/xlsx/pandoc/wikipedia) are reachable
    during evaluation. The loosening is confined to `eval/hooks.rs`; the product
    approval path and the SSRF guard are untouched.
- **Consequences:** The formatting failure class and all abstentions become
  scored attempts; the report attributes gains to formatting vs capability;
  benchmark runs can measure sampling and thinking without code changes.
- **Owner:** team.
- **Links:** [`src-tauri/src/core/agent/eval/answer.rs`](src-tauri/src/core/agent/eval/answer.rs),
  [`src-tauri/src/core/agent/eval/mod.rs`](src-tauri/src/core/agent/eval/mod.rs),
  [`src-tauri/src/core/agent/eval/scoring.rs`](src-tauri/src/core/agent/eval/scoring.rs),
  [`src-tauri/src/core/agent/eval/hooks.rs`](src-tauri/src/core/agent/eval/hooks.rs).
