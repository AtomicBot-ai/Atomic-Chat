---
date: 2026-08-07
title: "Keep sidebar and model-picker interactions off the I/O path"
---

# 2026-08-07 — Keep sidebar and model-picker interactions off the I/O path

- **Context:** Navigating the left sidebar and picking a model felt sluggish, and the
  cost was not model load time. Four interaction paths each charged work to the main
  thread that the rendered UI never used:
  - Every `ThreadItem` fetched the thread's full message history on mount, but the
    preview text that history feeds is only rendered on project cards. A history list
    of N rows paid N `fetchMessages` round-trips plus N store writes for titles.
  - `useThreadManagement()` returned the whole store (so any folder change re-rendered
    every subscriber) and ran `getProjects()` on **each** mount. `ThreadItem` called it
    twice, so opening the sidebar issued one projects read per row.
  - Opening the model list probed `checkMmprojExists` for every active `llamacpp`
    model, and each positive result called `updateProvider`, rewriting the entire
    `providers` array. Because the effect depended on `providers`, its own writes
    re-triggered it.
  - Picking a model changed the selection first, which woke ChatInput's auto-start
    effect. That effect issued two more `getActiveModels` probes and enqueued a second
    `switchToModel` for the identical target. Being enqueued later, it superseded the
    explicit switch — so a user-initiated load that failed reported through the silent
    auto-start path.

- **Decision:** Interaction handlers do only the work the visible UI needs. Sidebar rows
  never hydrate messages unless they render a preview; the initial projects read has one
  owner (`ensureProjectsLoaded`, called from `DataProvider`); capability probes are
  cached per model id and flushed to the store in one write; and an in-flight explicit
  switch marks its target so the auto-start path stands down for it.

- **Consequences:**
  - Opening a history list issues no message I/O. `lastUserMessageText` is only computed
    for project cards, which is the only place it was ever displayed.
  - `useThreadManagementStore` is exported for selector subscriptions. `useThreadManagement()`
    still returns the whole store for existing callers, but no longer re-reads projects
    per mount — a failed read clears the memo so a later consumer retries. In-app mutations
    already refresh `folders` themselves, so nothing depends on the old per-mount sync.
  - `setSidebarMode` compares before it sets. Opening a thread re-asserts the current
    mode on every navigation, and that no-op used to notify `LeftSidebar`, `NavChats` and
    `NavProjects` on each click.
  - Vision detection keeps working for unselected models — the sweep still runs on open —
    but each model is probed at most once per session, models already carrying the
    capability are skipped, and the effect keys on the id list instead of `providers` so it
    cannot re-trigger itself. Detection is not restricted to the selected model, because
    that would drop the vision badge from every other row.
  - The flat 500ms sleep after a local model load is replaced by a 100ms floor plus a
    poll on `getActiveModels`, capped at the original 500ms budget. A switch to an engine
    that comes up promptly leaves the "pending" state roughly 400ms sooner; a slow engine
    still gets the full budget.
  - `isExplicitSwitchPending` is honoured by `shouldAttemptAutoStart` too, so every
    auto-start caller stands down while a user-initiated switch for that target runs. The
    trade-off: if an explicit switch fails, the auto-start path will not retry it — which
    is the point, since the explicit path surfaces the error itself.
  - `DownloadManagement` was left alone. It subscribes to the whole download store, but it
    does so inside itself, so progress ticks re-render only that subtree and never the
    sidebar around it.
  - Each invariant is pinned by a test: history rows call `fetchMessages` zero times,
    project cards call it once per row, three `useThreadManagement` consumers trigger one
    `getProjects`, an unchanged `setSidebarMode` notifies nobody, reopening the model list
    re-probes nothing and writes once, and an in-flight explicit switch blocks auto-start
    for its own target only.

- **Owner:** `team`
- **Links:**
  - `web-app/src/containers/ThreadList.tsx`, `web-app/src/hooks/useThreadManagement.ts`,
    `web-app/src/providers/DataProvider.tsx`
  - `web-app/src/hooks/useAgentMode.ts`, `web-app/src/components/left-sidebar/NavProjects.tsx`
  - `web-app/src/containers/DropdownModelProvider.tsx`, `web-app/src/containers/ChatInput.tsx`,
    `web-app/src/utils/switchModel.ts`
  - Tests: `web-app/src/hooks/__tests__/useThreadManagement.test.ts`,
    `web-app/src/containers/__tests__/DropdownModelProvider.visionProbe.test.tsx`,
    `web-app/src/containers/__tests__/ThreadList.test.tsx`,
    `web-app/src/utils/switchModel.test.ts`, `web-app/src/hooks/useAgentMode.test.ts`
  - Sidebar mode split this builds on:
    [Separate Chat and Agent navigation in the sidebar](2026-07-21-separate-chat-and-agent-navigation-in-the-sidebar.md)
