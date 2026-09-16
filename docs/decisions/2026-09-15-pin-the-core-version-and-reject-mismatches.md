---
date: 2026-09-15
title: "Pin the core version in the app and reject protocol mismatches"
---

# 2026-09-15 — Pin the core version in the app and reject protocol mismatches

- **Context:** The core is released from its own repository on its own cadence, while the app is
  built from this one. Without a pin, a build would silently take whatever the latest release
  happened to be, and an app could end up talking to a core whose control API it does not
  understand — or worse, attach to an owner started by a *different* app version already running on
  the same data folder.
- **Decision:** `package.json` carries `atomicCore.version` (plus the repository), and
  `scripts/download-core.mjs` fetches exactly that version's assets, verifying each against the
  release's `SHA256SUMS` before it is placed in `resources/bin`; a missing or mismatched checksum
  fails the build. On macOS both architecture binaries are fetched and `lipo`'d into one universal
  file. `ATOMIC_CORE_LOCAL` points the same script at an unreleased local build for development.
  At runtime, a client handshakes with `GET /atomic/v1/snapshot` and refuses an owner whose
  `protocol` differs, with `CORE_PROTOCOL_MISMATCH`, instead of starting a second core.
- **Consequences:** Upgrading the core is an explicit, reviewable change to one field, and the
  binary in a build is reproducible from it. A protocol bump requires shipping both sides together;
  the mismatch is reported to the user rather than resolved by killing the other process. On
  Windows a running core cannot be replaced in place, so an update requires stopping the owner
  first.
- **Owner:** team
- **Links:** `scripts/download-core.mjs`, `package.json` (`atomicCore`),
  `../../../atomic-chat-core/src/client/control-client.ts` (`handshake`)
