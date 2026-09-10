---
date: 2026-07-22
title: "Upload Agent skills from portable files"
---

# 2026-07-22 — Upload Agent skills from portable files

- **Context:** The Skills page imported only selected directories, while users
  expected a Claude-style upload dialog with drag-and-drop and portable skill
  files.
- **Decision:** Accept one `.md`, `.zip`, or `.skill` upload. Treat Markdown as
  the complete `SKILL.md`; require archives to contain exactly one
  `SKILL.md`, import files relative to its directory, and retain the existing
  traversal, symlink, entry-count, and expanded-size safeguards.
- **Consequences:** Custom skills can be uploaded through the file picker or
  native desktop drag-and-drop, including scripts and supporting archive
  files. Directory imports remain supported by the backend contract, while the
  Skills UI exposes the portable-file workflow.
- **Owner:** team.
- **Links:** [`src-tauri/src/core/agent/skills/authoring.rs`](src-tauri/src/core/agent/skills/authoring.rs),
  [`web-app/src/containers/AgentSkillUploadDialog.tsx`](web-app/src/containers/AgentSkillUploadDialog.tsx),
  [`web-app/src/routes/skills/index.tsx`](web-app/src/routes/skills/index.tsx).

---
