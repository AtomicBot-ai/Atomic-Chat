---
date: 2026-07-22
title: "Edit, export, and launch Agent skills from the Skills page"
---

# 2026-07-22 — Edit, export, and launch Agent skills from the Skills page

- **Context:** The Skills page could create, upload, enable, inspect, and
  delete custom skills, but it could not revise their authored content,
  package a skill for sharing, or start an Agent chat with a chosen workflow.
- **Decision:** Allow custom skills to update only their description and
  instructions while preserving identity, requirements, safety metadata, and
  auxiliary files. Export any valid skill as a deterministic `.skill` ZIP
  without symlinks or path escapes. Add card-level toggles and overflow
  actions, keep Edit and Uninstall custom-only, and route Try in chat to a new
  Agent Home session with the eligible skill preselected.
- **Consequences:** Users can maintain and share portable skills without
  manually editing the data folder, and can immediately exercise an enabled,
  compatible skill in a fresh Agent chat. Bundled skills remain immutable;
  disabled, erroneous, or unavailable skills cannot be tried.
- **Owner:** team.
- **Links:** [`src-tauri/src/core/agent/skills/authoring.rs`](src-tauri/src/core/agent/skills/authoring.rs),
  [`web-app/src/routes/skills/index.tsx`](web-app/src/routes/skills/index.tsx),
  [`web-app/src/containers/AgentSkillEditDialog.tsx`](web-app/src/containers/AgentSkillEditDialog.tsx),
  [`web-app/src/containers/ChatInput.tsx`](web-app/src/containers/ChatInput.tsx).

---
