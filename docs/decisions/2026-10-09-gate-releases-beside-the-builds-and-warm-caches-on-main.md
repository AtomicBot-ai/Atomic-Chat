---
date: 2026-10-09
title: "Gate releases beside the builds and warm their caches on main"
---

# 2026-10-09 — Gate releases beside the builds and warm their caches on main

- **Context:** `Build & Release` took ~45 min for a green run (v2.2.0) and ~95 min with re-runs
  (v2.2.1), at two to four runs a day. Windows x64 set the pace, and in it:
  - the Rust gates ran before `tauri build`, in the same job: 13–14 min, of which ~6 min were four
    recompilations of the app crate. `build.rs` watched `src-tauri/.env` with `rerun-if-changed`, and
    Cargo treats a missing path as always stale, so every cargo call without `.env` reran the build
    script and recompiled the crate;
  - nothing was cached. Rust caches were saved only from `main`, where no workflow ran, so the repo
    held zero caches. The Yarn cache pointed at `.yarn/cache`, which Yarn 4 leaves empty. macOS had no
    Rust cache at all;
  - the web app was built twice: once early, then again by `tauri build`'s `beforeBuildCommand`. The
    early build was the one that uploaded Sentry source maps, but the shipped bundle is the second one,
    so the maps never matched the JS users ran;
  - re-running a failed job could not upload a file that already existed. In v2.2.1, `latest.json`
    failed with "Validation Failed".
- **Decision:**
  - **Gates run beside the builds.** `gate-macos`, `gate-windows` and `gate-linux` are separate jobs.
    They compile the tests against inert stubs (`make stub-resources`, a one-line `web-app/dist`) with
    the release's own cargo flags, as one `cargo test -- <filters…>`.
  - **Upload waits for build and gate.** The build jobs hand their installers over as Actions
    artifacts. `upload-macos`, `upload-windows` and `upload-linux-x64` put them into the draft only when
    both the build and the gate passed. `latest.json` lists only uploaded platforms that have a
    signature, and only after checking that each URL is an asset of the draft.
  - **Uploads replace same-named assets** (`.github/actions/upload-draft-assets`), and only on a draft.
  - **Release runs are serialized per tag.**
  - **The web bundle is built once, by `tauri build`.** The source-map upload env moved to that step.
  - **`build.rs` watches `.env` only while it exists.**
  - **Caches are written on `main`, read by releases.** `warm-cache.yml` writes the Rust caches
    (`release-<platform>`, `gate-<platform>`) and the Yarn cache: nightly, on dependency changes and on
    dispatch. Release jobs and gates only restore, since a `main` cache is readable from every branch
    and tag. That is also why releases need no dedicated release branch.
  - **Rust is pinned** (`ATOMIC_RUST_TOOLCHAIN`, 1.99.0) in both workflows, so the warm-up and the
    release share cache keys.
  - **`ctoml` is replaced by `scripts/set-cargo-package-version.mjs`.** `cargo install ctoml` compiled a
    crate in every job.
  - **What stays the same:** the release artifacts (platforms, MSI, NSIS/LZMA, signing, notarization,
    updater signatures, Sentry debug files), fat LTO, and the macOS build on `macos-latest-xlarge`. The
    macOS gate and warm-up run on a standard runner of the same image.
- **Consequences:**
  - A failing gate shows at its own job's pace instead of after ~20 min of the build.
  - Re-running a failed gate or upload reuses the build's artifact instead of compiling again.
  - The transfer through Actions artifacts adds an up- and download per platform (macOS ≈1.6 GB,
    uploaded uncompressed).
  - Cache reuse depends on the warm-up and the release agreeing on runner image, toolchain, targets,
    configs and `CARGO*`/`RUST*`/`CC*` env. A toolchain bump goes into both workflows, followed by a
    warm-up run.
  - The repository's cache is capped at 10 GB: eight Rust caches plus Yarn caches have to fit, which
    the first warm-up measures. If they do not fit, the least useful gate caches go first.
  - Creating a `src-tauri/.env` where none was needs a `touch src-tauri/build.rs` once
    (`DEVELOP.md`). Without `.env`, local cargo calls no longer recompile the crate every time.
  - Thin LTO, Windows Defender exclusions and Dev Drive are left for separate measured experiments.
- **Owner:** team
- **Links:** `.github/workflows/release.yml`, `.github/workflows/warm-cache.yml`,
  `.github/actions/upload-draft-assets/action.yml`, `.github/actions/build-summary/action.yml`,
  `src-tauri/build.rs`, `scripts/stub-tauri-resources.ps1`, `scripts/set-cargo-package-version.mjs`,
  runs [v2.2.0](https://github.com/AtomicBot-ai/Atomic-Chat/actions/runs/37783846464) and
  [v2.2.1](https://github.com/AtomicBot-ai/Atomic-Chat/actions/runs/37815757276).
