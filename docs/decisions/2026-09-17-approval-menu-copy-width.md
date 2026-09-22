---
date: 2026-09-17
title: 'Give the approval menu room for a complete Full access sentence'
---

# 2026-09-17 — Give the approval menu room for a complete Full access sentence

- **Context:** The composer's 20rem approval menu wraps the Full access subtitle to four lines at Extra Large. The separate confirmation dialog's width does not affect this menu.
- **Decision:** Use a 26rem menu capped at the viewport minus 2rem, with 1rem collision padding. Say exactly: "Runs every tool call without asking, including access to files and the internet." Keep the titles, row anatomy, and approval behavior unchanged.
- **Consequences:** Both descriptions fit within two lines at Medium, Large, and Extra Large in desktop windows. Narrow windows may use more lines while keeping all copy and both icon columns visible. Chromium tests cover desktop and narrow viewports, both themes, and both selected modes.
- **Owner:** team.
- **Links:** `web-app/src/containers/AgentApprovalModeSelect.tsx`, `web-app/src/containers/AgentApprovalModeSelect.layout.test.tsx`, `web-app/src/locales/en/chat.json`.
