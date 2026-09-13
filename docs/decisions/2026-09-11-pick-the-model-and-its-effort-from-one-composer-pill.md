---
date: 2026-09-11
title: "Pick the model and its reasoning effort from one composer pill"
---

# 2026-09-11 — Pick the model and its reasoning effort from one composer pill

- **Context:** The model was chosen from a pill in the page header, three
  routes each mounting their own copy, while everything else that shapes the
  next reply — approval mode, connectors, web search, the reasoning bulb, the
  effort level — sat in the composer toolbar. The reasoning effort in
  particular lived on the bulb: a level label beside it opened a slider, and
  the model it applied to was a screen-height away. Codex and ChatGPT put the
  model in the composer and hang the effort off the model, and that is the
  shape users now expect: the level is a property of *this model's* reply, not
  of the bulb.

- **Decision:** One pill in the composer's right-hand cluster, beside the
  microphone and Send, names the model and — while thinking is on — the level
  it thinks at (`DropdownModelProvider`). Its panel opens on the model row with
  the effort slider under it; the row leads into the searchable model list,
  with a Back button to return. With nothing selected the panel opens straight
  on the list, since a row that could only say "Select a model" is a click for
  nothing. The bulb (`ReasoningToggle`) keeps exactly one job: thinking on or
  off. The header no longer carries a model picker on any route.

- **Consequences:**
  - The slider is its own component (`ReasoningEffortPanel`) and reads the
    scale through `useReasoningEffort`, which the pill uses for its label and
    the bulb could use as well — the three cannot disagree on whether there is
    a level to show.
  - The panel mounts with the popover and unmounts with it, which is what
    clears a drag cut short by Escape; the previous design needed an explicit
    reset for that and a guard against the picker springing back open when a
    model's reasoning support flickered during a provider refresh. Both
    hazards are gone with the flag they lived on.
  - `DropdownModelProvider`'s startup effect (which restores the last used
    model) now runs from the composer instead of the header. Every chat route
    mounts the composer, so the coverage is unchanged, but a future route with
    a composer and no picker would lose the restore.
  - The context-size badge moved from beside the header pill into the panel's
    model row. It is one click further away; the header keeps only the context
    gauge on a running thread.
  - Tests that read the model list now step into it first — the panel opens on
    the row whenever a model is selected.

- **Owner:** `team`.
- **Links:** `web-app/src/containers/DropdownModelProvider.tsx`,
  `web-app/src/containers/ReasoningEffortPanel.tsx`,
  `web-app/src/containers/ReasoningToggle.tsx`,
  `web-app/src/hooks/useReasoningEffort.ts`,
  `web-app/src/containers/ChatInput.tsx`.
