---
date: 2026-07-21
title: "Author and import custom Agent skills in the Skills UI"
---

# 2026-07-21 — Author and import custom Agent skills in the Skills UI

- **Context:** The Skills page could inspect, enable, disable, refresh, and
  delete custom skills, but adding one required manually writing files in the
  Atomic Chat data folder.
- **Decision:** Add one Create New menu with two paths: author a minimal
  `SKILL.md` from validated name, description, and instructions fields, or
  import a selected directory containing a valid `SKILL.md`. Keep both paths
  backend-owned, reject reserved names, collisions, symlinks, traversal, and
  oversized imports, and select the resulting skill after registry refresh.
- **Consequences:** Users can add custom skills without leaving Atomic Chat,
  while bundled skills remain immutable and imported auxiliary files stay
  available to the skill. Existing skill directories are never overwritten.
- **Owner:** team.
- **Links:** [`src-tauri/src/core/agent/skills/authoring.rs`](src-tauri/src/core/agent/skills/authoring.rs),
  [`web-app/src/containers/AgentSkillCreateDialog.tsx`](web-app/src/containers/AgentSkillCreateDialog.tsx),
  [`web-app/src/routes/skills/index.tsx`](web-app/src/routes/skills/index.tsx).

---
