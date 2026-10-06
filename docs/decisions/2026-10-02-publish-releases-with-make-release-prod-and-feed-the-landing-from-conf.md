---
date: 2026-10-02
title: "Publish releases with make release-prod and feed the landing page from conf"
---

# 2026-10-02 — Publish releases with make release-prod and feed the landing page from conf

- **Context:** The release workflow leaves a draft release; someone published it by hand on GitHub and then
  edited the installer links on the atomic.chat landing page (Webflow) to the new versioned asset names. The
  links live on nearly every page, and the edit was easy to miss: on 2026-10-02 the English pages pointed at
  v2.1.2 while every `/ja` page still pointed at v2.0.44. Versioned asset names stay, so
  `releases/latest/download/<name>` cannot give a stable link, and calling `api.github.com` from the page hits
  the 60 requests/hour/IP limit on shared networks — the same reason the backend manifests moved to
  atomic-chat-conf (ATO-199).
- **Decision:** `make release-prod 2.1.3` (`scripts/release-prod.mjs`) publishes the named draft or
  pre-release — the version is required, so nobody publishes a draft they did not mean to — provided it is
  newer than the latest release and carries the macOS `.dmg`, Windows x64 `-setup.exe`,
  Linux `.AppImage` and the updater `latest.json`, and marks it latest. It then reads the published asset URLs
  and commits atomic-chat-conf `app/latest.json` (version, tag, release URL, one installer URL per platform)
  to `main` through the GitHub contents API. The landing page fetches that file from
  `raw.githubusercontent.com` on load and swaps its installer links; the links already in the page are the
  fallback.
- **Consequences:** A release reaches the landing page within the ~5 minute raw.githubusercontent.com cache,
  with no Webflow edit. A release missing a platform's installer is refused rather than published half-linked.
  If the manifest commit fails after the publish, re-running `make release-prod` on the now-latest release
  rewrites only the manifest. The command needs a `gh` login with write access to both repositories. The
  in-app updater is unchanged: it still reads the release's own `latest.json` asset.
- **Owner:** team.
- **Links:** `scripts/release-prod.mjs`, `Makefile` (`release-prod`), atomic-chat-conf `app/latest.json`,
  `app/schema.json`.
