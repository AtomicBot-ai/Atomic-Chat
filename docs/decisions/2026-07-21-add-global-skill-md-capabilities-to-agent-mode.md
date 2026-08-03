---
date: 2026-07-21
title: "Add global SKILL.md capabilities to Agent mode"
---

# 2026-07-21 — Add global SKILL.md capabilities to Agent mode

- **Context:** The Rust Agent had a fixed tool catalog but could not consume
  reusable Atomic Agent `SKILL.md` workflows, persist loaded instructions, or
  expose local skill management in Atomic Chat.
- **Decision:** Use `<data-folder>/agent-skills` as the single skill root.
  Seed the 17 bundled starter skills on every startup, replacing only reserved
  bundled names while preserving custom directories and durable disabled
  names. Render eligible summaries in stable-prefix `### skills`, materialize
  bodies through `skill.view` into bounded session-persisted
  `### loaded-skills`, and execute only declared scripts through
  approval-gated `skill.run_script` with shell-policy, path, timeout, output,
  and cancellation guards. Expose local list/detail, enable/disable, refresh,
  and custom-delete controls on an Agent-mode-only Skills sidebar page.
- **Consequences:** Agent can reuse the Atomic Agent starter workflows without
  network installation or project-local precedence. The new stable skill
  catalog invalidates prompt-prefix cache once; loaded bodies remain in the
  variable tail and `agent-session.json`. Bundled updates overwrite local
  edits to reserved skills on release, custom skills remain user-owned, and
  every script run still requires explicit approval.
- **Owner:** team.
- **Links:** [`src-tauri/src/core/agent/skills/`](src-tauri/src/core/agent/skills/),
  [`src-tauri/src/core/agent/tools/skill_view.rs`](src-tauri/src/core/agent/tools/skill_view.rs),
  [`src-tauri/src/core/agent/tools/skill_run_script.rs`](src-tauri/src/core/agent/tools/skill_run_script.rs),
  [`web-app/src/routes/skills/index.tsx`](web-app/src/routes/skills/index.tsx).

---
