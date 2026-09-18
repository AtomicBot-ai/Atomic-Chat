---
date: 2026-09-18
title: "Preserve the resolved backend during provider settings writes"
---

# 2026-09-18 — Preserve the resolved backend during provider settings writes

- **Context:** Backend discovery can replace `version_backend` after the provider settings page has rendered. A user toggling an unrelated control sent the page's entire older settings snapshot back to the extension. Separately, the shared settings registrar replaced an invalid stored value with the first dropdown option even when the extension supplied a valid default; the first option was the `latest/` download sentinel. The desktop e2e teardown caught an unintended backend download.
- **Decision:** For llama.cpp provider controls other than `version_backend`, send only the setting changed by the action and any coupled setting it deliberately changes. When a persisted dropdown value is no longer offered, the shared registrar uses the extension's registered default if that default is offered, then falls back to the first option. Keep the existing full update for an explicit backend selection.
- **Consequences:** A fit or other control change cannot restore a stale backend selection, and first launch selects the installed backend rather than a download sentinel. Coupled Concurrent Mode and metrics values still travel together. Extensions that provide a valid dropdown default now retain that default when old storage is invalid; the desktop e2e provider-settings journey checks that no unrequested backend was installed.
- **Owner:** team
- **Links:** `web-app/src/routes/settings/providers/$providerName.tsx`, `tests/e2e/desktop/provider-settings.spec.ts`, `core/src/browser/extension.ts`
