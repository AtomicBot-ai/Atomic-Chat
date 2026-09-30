---
date: 2026-09-15
title: "Restore loaded skills from disk, not from the session copy"
---

# 2026-09-15 — Restore loaded skills from disk, not from the session copy

- **Context:** A skill the model loaded with `skill.view` is persisted in the
  agent session (`LoadedSkillState`, body included) and restored at the start
  of every later turn. `LoadedSkills::restore` kept the persisted body as long
  as the manifest `version` still matched, so an edit to `SKILL.md` that did
  not bump `version` never reached a thread that had already loaded the skill.
  The docs promise "edits take effect on your next message", and the chat
  path already re-reads bodies (2026-09-14). Users on Linux reported edited
  skills the model "never sees".
- **Decision:** Treat the persisted entry as a record of *what* was loaded,
  not of its text. On restore, rebuild each entry's body and version from the
  registry the turn just loaded, keeping the entry's position and load time;
  drop entries whose skill is gone, disabled, or incompatible. The prompt text
  for a loaded skill is built by one function shared by `skill.view` and
  restore.
- **Consequences:** An edited skill is live on the next message in agent
  threads too, with or without a version bump. A version bump no longer evicts
  a loaded skill; the model keeps it, refreshed. Bundled skills are still
  re-seeded from the installer on every launch, so editing one of those in
  place still does not stick — that behaviour is documented and unchanged.
  As before, a skill whose `SKILL.md` fails to parse at the moment a message
  is sent is dropped from the loaded set silently and returns only when the
  model calls `skill.view` again.
- **Owner:** @danyurkin.
- **Links:** [`src-tauri/src/core/agent/skills/loaded.rs`](../../src-tauri/src/core/agent/skills/loaded.rs),
  [2026-09-14 Re-read skill bodies when a skill changes](2026-09-14-re-read-skill-bodies-when-a-skill-changes.md),
  [2026-07-21 Add global SKILL.md capabilities to Agent mode](2026-07-21-add-global-skill-md-capabilities-to-agent-mode.md).
