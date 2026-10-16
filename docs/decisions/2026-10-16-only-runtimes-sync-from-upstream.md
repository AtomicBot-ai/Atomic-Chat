---
date: 2026-10-16
title: "Only the inference runtimes sync from upstream; registries are bundled, PostHog and the Atomic Agent integration are removed, crash reporting becomes Radium's own and opt-in"
---

# 2026-10-16 — Only the inference runtimes sync from upstream; registries are bundled, PostHog and the Atomic Agent integration are removed, crash reporting becomes Radium's own and opt-in

- **Context:** Radium is a fork of Atomic Chat, and at every launch it still
  pulled what it showed from upstream's repositories. The provider registry,
  recommended models, staff picks, media registry and model catalog came from
  `AtomicBot-ai/atomic-chat-conf` and `atomic-chat-model-catalog`. The default
  models and DFlash/MTP drafters were upstream's own Hugging Face re-uploads
  under `AtomicChat/`. The app sent PostHog analytics and Sentry crash reports
  to upstream's projects, and `release.yml` wrote a `latest.json` pointing at
  upstream's releases. The Launch page installed upstream's Atomic Agent from
  `atomicagent.io`, and the assistant's default prompt sent users to
  `atomic.chat`. So a third party could change what Radium recommends, which
  providers it offers and where its data goes, without a Radium release.
- **Decision:** Nothing syncs from upstream except the inference runtimes:
  the TurboQuant llama.cpp fork, the mirrored upstream llama.cpp builds with
  their backend manifests, the build-time backend downloads and the MLX
  server. The neutral ollama and stable-diffusion.cpp integrations are
  unaffected.
  - Every registry ships as a reviewed snapshot: `web-app/src/registries/*.json`,
    plus `web-app/public/seed-catalog*.json.gz` for the catalog. The app makes
    no request for them. A build may set `VITE_PROVIDER_REGISTRY_URL`,
    `VITE_RECOMMENDED_MODELS_REGISTRY_URL`, `VITE_STAFF_PICKS_REGISTRY_URL`,
    `VITE_MEDIA_REGISTRY_URL`, `VITE_MODEL_CATALOG_URL` or
    `VITE_MODEL_CATALOG_INDEX_URL` to opt into a remote source. All six
    default to empty (`web-app/src/lib/registry-source.ts`).
  - Default models and fallback cards point at verified neutral repositories
    (unsloth and the models' own orgs). DFlash Q8_0 drafters come from Anbeeld's
    conversions of the z-lab reference drafters, and the Gemma 4 26B-A4B MTP
    head comes from unsloth. Every file, size and SHA-256 was read from Hugging
    Face on 2026-10-16. Users' existing `AtomicChat/` downloads keep working;
    nothing renames or deletes them.
  - PostHog is removed from the web app, the Rust backend, the extensions,
    the CSP and `release.yml`, along with the Privacy page's analytics opt-in.
  - Sentry stays, for crash reports only, and it is now Radium's own
    (`web-app/src/lib/crash-reporting.ts`):
    - The DSN comes only from the optional `SENTRY_DSN` build secret. No DSN
      is written in the repository. Without one the SDK is never initialised.
    - It is opt-in and off by default for new and existing users. The consent
      inherited from upstream (`productAnalytic`) is deleted, never read.
    - Settings → Privacy has a "Send crash reports" toggle, which is disabled
      in a build without a DSN.
    - `beforeSend` and `beforeBreadcrumb` drop everything while consent is
      off. When it is on they send errors only: no tracing, replay or
      sessions. The `user` field, request bodies and query strings are
      removed. Only navigation and click breadcrumbs survive. Prompt and
      message fields are redacted, and so are home-directory user names, API
      keys, bearer tokens and e-mail addresses.
    - The CSP allows only Sentry's ingest hosts (`*.ingest.sentry.io`, `.us`,
      `.de`) in `connect-src`.
    - The Rust-side Sentry client, the source-map upload and the debug-file
      upload are not restored.
  - The CSP's `raw.githubusercontent.com` source is narrowed to the
    backend-manifest path. The `publish-latest-json` job and
    `src-tauri/latest.json.template` are deleted, which finishes
    `2026-09-12-radium-never-auto-updates.md`.
  - The Atomic Agent Launch-page integration is removed. The in-app Agent mode
    is Radium's own and stays.
  - The assistant's default prompt describes Radium and no longer names a
    website. A v5 migration rewrites the old sentence in saved assistants and
    leaves the rest of their text alone.
- **Consequences:**
  - The app works offline from first launch, and a curated list changes only
    through a reviewed commit in this repository. The cost is that new
    providers, recommendations and catalog entries arrive with a release.
    `node web-app/scripts/snapshot-registries.mjs <kind> <url>` refreshes a
    snapshot from a source someone chooses; it rewrites or drops
    upstream-owned entries and refuses to write a file that still names them.
  - `tests/no-atomic-sources.test.mjs`, run by `make verify` through
    `test-hardening-contracts`, scans production sources, CI and the bundled
    snapshots for upstream sources, analytics and hard-coded DSNs. Runtime files are
    allowlisted by name with a reason, and even those may name only runtime
    sources. `web-app/src/constants/__tests__/recommendation-ladder.test.ts`
    keeps the ladder, its fallback cards and the bundled tiers in agreement.
  - Crash reports reach Warwick only from users who opt in, and only from
    builds given a DSN. Native (Rust) panics are not reported.
  - The backend-manifest fetches still reach `AtomicBot-ai` on GitHub. That is
    the deliberate exception and the guard test allows it.
- **Owner:** @walladanger
- **Links:** `web-app/src/registries/README.md`, `web-app/src/services/AGENTS.md`,
  `tests/no-atomic-sources.test.mjs`, `tests/csp-connect-src.test.mjs`.

<!--
Supersedes: 2026-08-25-add-atomic-agent-as-a-one-click-launch-page-assistant.md
Supersedes: 2026-09-10-media-models-and-providers-come-from-atomic-chat-conf.md
Supersedes: 2026-05-27-replace-janhq-model-catalog-fuse-js-with-curated-atomicbot-ai.md (source of the catalog only; MiniSearch stays)
Supersedes: 2026-08-06-serve-hub-staff-picks-from-a-separate-manifest-and-split-view.md (source of the manifest only)
Supersedes: 2026-07-13-default-upstream-dflash-downloads-to-atomic-chat-q8-0-for-every.md
Supersedes: 2026-07-13-offer-every-published-atomic-chat-dflash-gguf-to-llamacpp.md (the AtomicChat repos; every family is still offered)
Supersedes: 2026-06-09-add-zero-pii-sentry-crash-error-tracking-to-both-the-react.md (consent, DSN source and the Rust client; frontend crash reporting stays, opt-in)
Supersedes: 2026-08-17-track-llm-response-outcomes-and-close-onboarding-funnel-gaps.md
Supersedes: 2026-08-17-rename-the-string-status-property-that-posthog-had-typed-numeric.md
Supersedes: 2026-08-03-triage-the-sentry-backlog-fix-real-defects-and-stop.md (the reporting half; the defect fixes stay)
-->
