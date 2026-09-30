---
date: 2026-09-15
title: "Mark Full access by its icon and words, not by colour"
---

# 2026-09-15 — Mark Full access by its icon and words, not by colour

- **Context:** The composer's approval select has two modes, "Ask for
  approval" (`manual`) and "Full access" (`skip`). Full access used the
  destructive variant: a red shield-off icon, red title and description in the
  menu, and a red trigger in the toolbar while selected. It read as an error
  state rather than a choice, and users were put off a mode that is legitimately
  theirs to pick. ATO-532 proposes Unsloth Studio's four-mode menu with Full
  access marked in orange.

- **Decision:** Keep our two modes and adopt the reference layout: a trigger
  with the mode's icon, label and a chevron; a menu titled "How should tool
  calls be approved?"; each row an icon, a title, a muted description and a
  checkmark on the selected one. Full access gets no colour of its own: its
  circle-alert icon is muted like the Hand of "Ask for approval", in the menu
  and on the trigger. An amber icon was tried first and still singled the mode
  out as a warning. Its description keeps the same facts in a calmer register
  ("No approval prompts: tool calls can use the internet and any file on your
  computer").

- **Consequences:**
  - The risk is stated in words and by the icon's shape. Nothing in colour
    tells the two modes apart at a glance, so the trigger label is what says
    which one is on.
  - No confirmation step when switching to Full access; Unsloth adds one
    because its Full access also disables a code sandbox, which ours does not
    have. Revisit if Full access ever widens beyond skipping prompts.
  - The "Approve for me" / "Run automatically" middle modes from ATO-532 are
    not adopted; the approval engine only knows `manual` and `skip`.

- **Owner:** `team`.
- **Links:** ATO-532;
  `web-app/src/containers/AgentApprovalModeSelect.tsx`,
  `web-app/src/containers/ChatInput.tsx`, `web-app/src/lib/mcp-approval.ts`.
