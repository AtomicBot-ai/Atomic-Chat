---
date: 2026-07-27
title: "Reconcile remote providers before proxy-routed requests"
---

# 2026-07-27 — Reconcile remote providers before proxy-routed requests

- **Context:** Remote models intentionally send through the Local API Server
  proxy, but startup left that proxy stopped when no local engine model was
  active. A restored remote selection could therefore send its first request
  to an unavailable `localhost:1337` and fail with connection refused until
  the user reselected the model.
- **Decision:** Add one serialized, idempotent remote-provider readiness
  preflight that validates and registers the selected provider, then starts
  the Local API Server when needed. Invoke it after provider hydration for the
  restored remote selection and immediately before constructing a remote chat
  model. Keep remote traffic on the existing local proxy architecture.
- **Consequences:** Restored and first-use remote models cannot race provider
  registration or proxy startup. Local-engine startup policy remains
  unchanged, while remote sends may now wait for one bounded proxy-start
  attempt and surface its failure before model construction.
- **Owner:** team.
- **Links:** [ATO-306](https://linear.app/atomicchat/issue/ATO-306),
  [`web-app/src/utils/ensureRemoteProviderReady.ts`](web-app/src/utils/ensureRemoteProviderReady.ts),
  [`web-app/src/providers/DataProvider.tsx`](web-app/src/providers/DataProvider.tsx),
  [`web-app/src/lib/custom-chat-transport.ts`](web-app/src/lib/custom-chat-transport.ts).
