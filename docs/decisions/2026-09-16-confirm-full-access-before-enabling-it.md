---
date: 2026-09-16
title: "Confirm Full access before enabling it, every time"
---

# 2026-09-16 — Confirm Full access before enabling it, every time

- **Context:** The composer's approval select offers "Ask for approval"
  (`manual`) and "Full access" (`skip`). Since 2026-09-15 the two rows look
  alike: Full access is told apart by its icon and words, not by colour. That
  record also chose *not* to confirm the switch, reasoning that our Full
  access only skips prompts. With no colour and no confirmation, one click in
  a menu now hands every tool call the internet and every file on the
  computer, and nothing tells the user what they just did. The competitor
  menu Danny took the copy from confirms the switch.

- **Decision:** Picking Full access opens a dialog ("Enable Full access?")
  that says what the mode lets tool calls do — modify or delete files, run
  commands, make network requests — with "Cancel" and "I understand". Only
  "I understand" changes the mode; Cancel, Escape and the close button leave
  it as it was. The dialog is per choice, not remembered: picking Full access
  again later asks again. Danny wants the extra confirmation each time, so
  there is no "don't ask again" and nothing is stored. "Ask for approval"
  never asks. The rows' descriptions adopt the competitor's wording minus its
  sandbox clause (Atomic Chat has no code sandbox): "Always ask before tool
  calls edit files or use the internet" and "Unrestricted: no approval
  prompts for any tool call, including the internet and any file on your
  computer". The accept button uses the normal primary style, not
  destructive red — the 2026-09-15 rule that Full access carries no colour
  of its own still holds.

- **Consequences:**
  - Full access costs two clicks instead of one, in every thread and every
    time. That is the point; if it ever grates, the fix is a remembered
    choice, not dropping the dialog.
  - The dialog copy is the one place that spells out what Full access can do,
    so it is what to edit when the tool set widens.
  - The select takes the dialog strings as props like the rest of its copy;
    the keys live under `chat:agentApprovals.skipConfirm*` (English only, other
    locales fall back).
  - Supersedes the "no confirmation step" consequence of
    2026-09-15-mark-full-access-by-icon-and-words-not-colour.md; the colour
    decision there stands.

- **Owner:** `team`.
- **Links:** `web-app/src/containers/AgentApprovalModeSelect.tsx`,
  `web-app/src/containers/ChatInput.tsx`,
  `web-app/src/locales/en/chat.json` (`agentApprovals`),
  `web-app/src/containers/__tests__/AgentApprovalModeSelect.test.tsx`.
