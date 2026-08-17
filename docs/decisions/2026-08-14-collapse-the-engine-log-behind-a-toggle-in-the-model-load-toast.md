---
date: 2026-08-14
title: "Collapse the engine log behind a toggle in the model-load toast"
---

# 2026-08-14 — Collapse the engine log behind a toggle in the model-load toast

- **Context:** the generic model-load failure toast printed `err.message`
  verbatim. The llama.cpp extensions flatten the plugin error into
  `"<one-line reason>\n<raw engine output> [CODE]"`, so a crash covered half the
  window with GGML backtrace and `common_param` chatter, with the one sentence
  that mattered scrolled off the top. On a fresh install that wall of text was
  the first thing a user saw.
- **Decision:** the toast shows only the reason. When the engine also produced a
  log, a "Show details" toggle expands it in place — scrollable, selectable and
  next to a copy button, since that log is exactly what a bug report needs.
  Expanding pins the toast (`duration: Infinity`) and widens it, because a log
  being read must not vanish on the 10s timer; collapsing restores both. The
  split happens in `splitModelLoadError`, which strips the ` [CODE]` suffix,
  prefers the structured `details` field, and demotes an over-long single-line
  message to the details pane rather than truncating it away.
- **Consequences:** every model-load failure now costs one click to reach the
  diagnostics that used to be unavoidable. The toast is re-created (same
  `model-load-error` id) on each toggle, which is how sonner updates a live
  toast; anything that dismisses that id keeps working. Only the generic branch
  routes through the new helper — the classified branches (OOM, unsupported
  arch, missing file, …) already show a short actionable message and gain
  nothing from a log. Details are clamped to the last 20k characters.
- **Owner:** `team`
- **Links:** `web-app/src/containers/ModelLoadErrorToast.tsx`,
  `web-app/src/utils/switchModel.ts`,
  `web-app/src/containers/__tests__/ModelLoadErrorToast.test.tsx`
