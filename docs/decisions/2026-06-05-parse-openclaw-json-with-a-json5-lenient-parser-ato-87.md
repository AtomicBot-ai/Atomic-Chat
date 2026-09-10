---
date: 2026-06-05
title: "Parse `openclaw.json` with a JSON5-lenient parser (ATO-87)"
---

# 2026-06-05 — Parse `openclaw.json` with a JSON5-lenient parser (ATO-87)

- **Context:** Atomic Chat and OpenClaw read the **same** file
 `~/.openclaw/openclaw.json` with **different** parsers. OpenClaw uses
 lenient **JSON5** (comments, unquoted keys, trailing commas); our
 `configure_openclaw` in
 [`src-tauri/src/core/system/commands.rs`](src-tauri/src/core/system/commands.rs)
 used strict `serde_json::from_str`. A user (Discord, via [ATO-87](https://linear.app/atomicchat/issue/ATO-87))
 followed support advice to wrap `model` in `{ primary: ... }` with an
 **unquoted** `primary` key — valid JSON5, invalid strict JSON. OpenClaw
 accepted and reloaded the config (`config change applied`), while Atomic
 Chat failed with `Could not parse … as JSON`, giving the user a
 contradictory signal. The old error was also uninformative (no line/column)
 and suggested a manual workaround instead of just parsing the file. This
 **reverses** the 2026-06-01 ADR note ("no `json5` dep added") now that the
 parser-strictness mismatch is a confirmed user-facing bug.
- **Decision:** Add the `json5 = "0.4"` crate and read `openclaw.json` with
 `json5::from_str::<serde_json::Value>` (single source of truth for parse
 strictness with OpenClaw). On parse failure, surface the json5 error
 verbatim (it carries the offending line/column) instead of the generic
 "add the provider manually" advice. We still re-serialize as **strict**
 pretty JSON on write, which normalizes the file (and silently drops any
 JSON5 comments) — acceptable since JSON5 is a strict-JSON superset, so the
 normalized output is still valid for OpenClaw.
- **Consequences:** Configs OpenClaw accepts (unquoted keys, comments,
 trailing commas) no longer break Atomic Chat's Launch-page OpenClaw flow.
 Parse errors now point at a location. The write step rewrites the file as
 strict JSON, so user comments are lost on the next `configure_openclaw`
 run — a deliberate, self-healing trade-off. Scope is limited to OpenClaw;
 the other agent config writers (Claude/Codex/OpenCode/Hermes/Droid) still
 use strict `serde_json` and are untouched. The possible file-watcher
 debounce loop noted in ATO-87 is **not** addressed here (separate ticket if
 confirmed). `cargo check -p Atomic-Chat` passes.
- **Owner:** team.
- **Links:** [ATO-87](https://linear.app/atomicchat/issue/ATO-87),
 the 2026-06-03 ADR *Fix OpenClaw Launch integration*, the 2026-06-01 ADR
 *Add a "Launch" page …* (the "no `json5` dep" note this supersedes),
 files: [`src-tauri/src/core/system/commands.rs`](src-tauri/src/core/system/commands.rs)
 (`configure_openclaw`), [`src-tauri/Cargo.toml`](src-tauri/Cargo.toml).
