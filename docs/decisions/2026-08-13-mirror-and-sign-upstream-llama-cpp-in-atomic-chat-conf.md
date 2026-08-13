---
date: 2026-08-13
title: 'Mirror and sign upstream llama.cpp releases in atomic-chat-conf'
---

# 2026-08-13 — Mirror and sign upstream llama.cpp releases in atomic-chat-conf

- **Context:** Signing was asymmetric between the two local engines. TurboQuant
  releases are signed end to end — measured on `b10269-1.5.1`: macOS carries
  `Developer ID Application: SpaceshipIntelligence OU (UT6WGPGTGR)` with
  `flags=0x10000(runtime)` and a secure timestamp plus `notarytool`
  notarization, Windows carries Authenticode chaining `AtomicMail Systems OU` ->
  `DigiCert Trusted G4 Code Signing RSA4096 SHA384 2021 CA1`. `llamacpp-upstream`
  carried nothing: what a user downloads at runtime is the ad-hoc,
  linker-signed archive from `ggml-org`, and the `llama-server.exe` bundled
  inside our own signed NSIS/MSI installers was an unsigned ggml-org binary,
  because Windows CI signs only the installers. Each developer's machine
  re-signed the macOS asset locally in `download-llamacpp-upstream-backend`,
  so the same tag existed in two different signing states depending on which
  path produced it. Backend downloads also had no integrity check at all:
  `compute_file_sha256_with_cancellation` has been wired into
  `src-tauri/src/core/downloads/helpers.rs` for a while, but nothing passed a
  hash for a backend archive.
- **Decision:** `atomic-chat-conf` becomes an artefact registry for
  `llamacpp-upstream`, not just an index. `make mirror TAG=b10405` dispatches
  `.github/workflows/mirror-upstream.yml`, which downloads a whitelist of
  upstream assets, re-signs the Windows binaries through the
  `windows-code-sign` composite action ported from the TurboQuant fork
  (DigiCert KeyLocker, `smctl` + `signtool` over the extracted directory,
  repacked with 7-Zip because `Compress-Archive` takes tens of minutes on the
  CUDA and ROCm archives), re-signs every Mach-O in the macOS asset with
  `codesign --force --options runtime --timestamp --entitlements`, passes the
  Linux tarballs through untouched, then publishes a release under the upstream
  tag, regenerates `backends/manifest.json` with a `download_base` pointing at
  that release plus per-asset `sha256`/`size`, and prunes releases beyond
  `RETAIN` (3). The manifest moves only after the upload succeeds.

  The app reads `download_base` from the manifest;
  `LLAMACPP_DOWNLOAD_BASE` survives as the fallback, so a tag we have not
  mirrored still resolves to `ggml-org` and keeps working. `sha256` and `size`
  now travel into `downloadFiles`, which turns on the existing integrity check
  for free. `make dev` and CI resolve tag, asset, URL and hash through one
  `scripts/resolve-upstream-backend.mjs` — the five copies of that logic
  (three Makefile branches, the PowerShell branch, and the inline duplicate in
  `release.yml`) are gone, and both paths verify the hash before use. The macOS
  re-signing loop stays but became conditional: it runs only when `codesign -dv`
  does not already show our Team ID, which is exactly the `ggml-org` fallback
  case.

  Notarization is deliberately not part of the mirror. `stapler` does not apply
  to loose Mach-O binaries and Gatekeeper does not consult a subprocess spawned
  outside a `.app`; the value is the Developer ID signature with hardened
  runtime and a secure timestamp, which is also what makes one artefact usable
  as a bundled resource.
- **Consequences:**
  - One artefact serves both the bundled path and the runtime download, so a
    given tag has one signing state instead of two. The bundled Windows
    `llama-server.exe` becomes signed without touching a single signing step in
    `release.yml`.
  - Engine updates stop being a JSON edit. They are now: run the mirror, wait
    for CI, the manifest moves itself. This is precisely the cost the 2026-08-12
    ADR predicted when it rejected mirroring; we accept it in exchange for
    signatures, and the `ggml-org` fallback stays as insurance against a broken
    pipeline. Do not remove that fallback "for cleanliness".
  - Apple and DigiCert secrets now live in a second repository. `atomic-chat-conf`
    stops being a repository of JSON and becomes one with release signing
    authority; its access should be narrowed accordingly.
  - ~708 MB per tag in the releases of a public repository, ~2.1 GB at a
    retention of 3. 196.6 MB of that is the new Windows ROCm asset.
  - Linux archives remain unsigned — we have no Linux signing mechanism and this
    does not invent one.
  - The cudart companions (~391 MB each) stay on `ggml-org`: they contain
    NVIDIA-signed NVIDIA DLLs, and mirroring them would triple the mirror.
    `GGML_ORG_CUDART_PINNED_TAG` in the TurboQuant driver therefore stays a
    hand-maintained pin while the upstream driver's baseline is generated —
    known debt, left out of scope because the fix belongs in the fork driver
    tree.
  - macOS `verify_backend_binary` still gates only on the tag reported by
    `--version`. Requiring our Team ID via `codesign --verify` there is possible
    now that mirrored assets carry it, but it would break the `ggml-org`
    fallback, so it is not done.
- **Owner:** team
- **Links:**
  [`atomic-chat-conf/.github/workflows/mirror-upstream.yml`](https://github.com/AtomicBot-ai/atomic-chat-conf/blob/main/.github/workflows/mirror-upstream.yml),
  [`atomic-chat-conf/Makefile`](https://github.com/AtomicBot-ai/atomic-chat-conf/blob/main/Makefile),
  [`atomic-chat-conf/backends/schema.json`](https://github.com/AtomicBot-ai/atomic-chat-conf/blob/main/backends/schema.json),
  `scripts/resolve-upstream-backend.mjs`, `tests/upstream-backend-resolver.test.mjs`,
  `extensions/llamacpp-upstream-extension/src/backend.ts`, `Makefile`,
  `.github/workflows/release.yml`,
  `docs/decisions/2026-08-12-update-upstream-llama-cpp-at-runtime-on-macos-too.md`,
  `docs/decisions/2026-07-28-pin-backend-artifacts-to-verified-tags.md`

<!--
Supersedes: 2026-08-12-update-upstream-llama-cpp-at-runtime-on-macos-too.md
(only the "Mirroring re-signed upstream releases was rejected" clause)
-->
