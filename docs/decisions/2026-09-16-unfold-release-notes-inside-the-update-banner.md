---
date: 2026-09-16
title: "Unfold the release notes inside the update banner"
---

# 2026-09-16 — Unfold the release notes inside the update banner

- **Context:** The app-update banner (ATO-533) previews four bullets of the
  GitHub release body and offers "Show release notes", which sent the user to
  the release page in the system browser. The reference banner Danny wants to
  match (Unsloth Studio) keeps the user in the app: the link unfolds the full
  notes in place, with a small "Open release" link under them for the browser.
  Leaving the app to read a changelog is a bigger ask than the banner's own
  "Update" button, and it hid the part of the notes the four-bullet preview
  dropped — the intro paragraph and anything after "+N more".

- **Decision:** `<UpdateBanner />` gains an optional expandable body —
  `expanded`, `expandedContent`, `expandedAction` — which, when set, replaces
  the highlights inset with a 10 rem scroll box in the same 11 px type and a
  right-aligned "Open release" link under it. The banner stays presentational:
  the app container owns the open/closed flag, flips the left-hand link between
  "Show release notes" and "Hide release notes", and renders the body with bare
  `react-markdown` + `remark-gfm`, not the chat's `<RenderMarkdown />`, which
  pulls streamdown, mermaid, KaTeX (and its CSS) and the artifact panel into a
  24 rem toast that only ever shows paragraphs, headings, bullets and links.
  Both dependencies are already in `web-app/package.json`; nothing new is added.
  Links inside the notes are routed through the same opener as "Open release"
  so a click never navigates the webview. A release with an empty body keeps
  the old behaviour: "Show release notes" opens the browser, because there is
  nothing to unfold. The engine banner passes none of the new props and is
  unchanged.

- **Consequences:** The notes are readable without leaving the app and without
  the "What's new" dialog, which stays the post-update surface. A release whose
  bullets all sit in skipped sections (GitHub's default "What's Changed") now
  has a useful "Show release notes" even though its preview is empty. The
  scroll box caps the banner's height, so the header and the Remind me later /
  Update row never move when the notes unfold. Unfolded notes belong to one
  offer: a new version folds them back. The banner is `aria-live="polite"`, so
  unfolding announces the body once — acceptable for a user-initiated toggle.
  If the engine banner ever carries notes it can pass the same three props.

- **Owner:** @danyurkin

- **Links:** `web-app/src/containers/UpdateBanner.tsx`,
  `web-app/src/containers/dialogs/AppUpdater.tsx`,
  `web-app/src/containers/dialogs/__tests__/AppUpdater.test.tsx`,
  `web-app/src/locales/en/updater.json`,
  [2026-09-14 — One update banner in the bottom-right corner at a time](2026-09-14-one-update-banner-in-the-corner-at-a-time.md)
