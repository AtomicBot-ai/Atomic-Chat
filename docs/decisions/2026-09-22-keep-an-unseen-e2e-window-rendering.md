---
date: 2026-09-22
title: "Keep an unseen e2e window rendering"
---

# 2026-09-22 — Keep an unseen e2e window rendering

- **Context:** The desktop e2e window is kept on top and, since the record of
  the same day on the image engine, tunnel and catalog, on every Space
  (`visible_on_all_workspaces`), because WebKit gives a page no animation
  frames while its window is not seen, and the app removes its splash overlay
  from one. That record expected a full-screen app in front of the operator to
  stop stalling a run. It did not: "every Space" leaves out another app's
  full-screen Space, and the first full run after it, with the Claude app
  full-screen in front, timed out on the splash in all 74 sessions. The ones
  that did get past the splash then failed on popovers that never finished
  animating open ("the model picker did not open").
- **Decision:** The e2e build turns off the webview's window occlusion
  detection (`_setWindowOcclusionDetectionEnabled:` on the `WKWebView`, private
  WebKit API, called only with `--features e2e`, through an optional `objc2`
  dependency that only that feature enables). WebKit then counts the page as
  visible for as long as the window is ordered in, on whichever Space and
  behind whatever covers it. WebKit reads the switch only when it next works
  out the page's visibility, and the window is already on screen when the
  switch is set, so the view is hidden and shown once right after to make it do
  that at launch rather than at the operator's next Space switch.
- **Consequences:** With the operator on another app's full-screen Space and no
  e2e window on the active Space, a relaunched app loses its splash in about
  2.5 s and its page runs at 60 frames a second. Setting the switch without the
  hide-and-show was not enough: sessions launched while the window was unseen
  still timed out. A WebKit that drops the selector gets a warning in the app
  log and the old behaviour; a release build contains none of this. What still
  stops rendering is a minimised window or a sleeping display, which is what
  the harness's splash message now names.
- **Owner:** `team`.
- **Links:**
  - `src-tauri/src/core/e2e.rs` (`keep_rendering_unseen`), `src-tauri/Cargo.toml` (`e2e` feature)
  - `tests/e2e/harness/app.ts` (`waitForSplashToGo`)
  - `2026-09-22-desktop-e2e-brings-its-own-image-engine-tunnel-and-catalog.md` (its fourth finding)
