---
date: 2026-07-21
title: "Preload explicitly selected Agent skills"
---

# 2026-07-21 — Preload explicitly selected Agent skills

- **Context:** Agent could discover skills through the prompt catalog and load
  them with `skill.view`, but users could not bind a specific workflow to a
  turn from the composer or reproduce that choice during regeneration.
- **Decision:** In Agent mode, expose enabled and compatible skills through a
  slash picker with one removable chip. Persist the selected name as
  `agent_skill_name` on the user message and pass it as `selected_skill` in
  the Agent turn request. Before appending the user turn or performing the
  first completion, restore session-loaded skills and load the explicit
  selection through the existing bounded `LoadedSkills` state.
- **Consequences:** The selected skill body is guaranteed to appear in the
  first prompt's `### loaded-skills` section, and regenerate/edit-regenerate
  reuse the same selection. A skill that became missing, disabled,
  incompatible, or unavailable fails the turn before inference and leaves the
  user turn unpersisted in the Agent session.
- **Owner:** team.
- **Links:** [`web-app/src/containers/AgentSkillSlashMenu.tsx`](web-app/src/containers/AgentSkillSlashMenu.tsx),
  [`web-app/src/routes/threads/$threadId.tsx`](web-app/src/routes/threads/$threadId.tsx),
  [`src-tauri/src/core/agent/runner.rs`](src-tauri/src/core/agent/runner.rs).

---
