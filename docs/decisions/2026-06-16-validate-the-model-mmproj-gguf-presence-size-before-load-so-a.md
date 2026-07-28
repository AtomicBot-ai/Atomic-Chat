---
date: 2026-06-16
title: "Validate the model/mmproj GGUF (presence + size) before load so a missing/partial download fails fast with an actionable, classified error (ATO-187)"
---

# 2026-06-16 — Validate the model/mmproj GGUF (presence + size) before load so a missing/partial download fails fast with an actionable, classified error (ATO-187)

- **Context:** `model_load.error_code = 'MODEL_FILE_NOT_FOUND'` = 230 events / 18
  users over 30d (mostly Windows), with stderr `Invalid or inaccessible model
  path: \\?\C:\Users\...\model.ggu…` — Bug #3 of epic
  [ATO-181](https://linear.app/atomicchat/issue/ATO-181). Root cause is a
  desync between "model is in `model.yml`" and "the GGUF is actually a complete
  file on disk": an interrupted/partial download that never produced the final
  GGUF, a file removed outside the app, or (historically) a stale backend path.
  The Rust loader (`tauri-plugin-llamacpp{,-upstream}/src/path.rs ::
  validate_model_path`) only checks `.exists()` and **only after** the backend
  binary is spun up — so a genuinely missing file produces an opaque
  truncated-path crash, and a **partially-downloaded file that exists** slips
  past `.exists()` and fails deep inside the loader as an unclassified
  `LLAMA_CPP_PROCESS_ERROR`. The UI infra to handle this already existed
  end-to-end (`MODEL_FILE_NOT_FOUND` → "re-download" toast; `MODEL_FILE_CORRUPT`
  → "delete & re-download" toast in `switchModel.ts`, with EN/RU locale keys),
  but nothing classified the *partial-download* case, and classification of the
  missing-file case happened late.
- **Decision (per the issue's fix direction #1 — "validate presence + size
  before load"; the auto re-download (#1b) and stale-path rewrite (#2) were
  deliberately deferred as larger/riskier — auto re-download needs a source URL
  that `model.yml` does not store, a schema change out of this slice):** add a
  pre-load `validateModelArtifacts()` to `performLoad` in **both** llama.cpp
  extensions (`llamacpp-upstream-extension` — the Windows/Linux/macOS-default
  provider — and the macOS turboquant `llamacpp-extension`, for parity, mirroring
  the existing dual-provider text-only-fallback pattern). Right after the
  model/mmproj paths are resolved and **before** the backend `loadLlamaModel`
  call/try-block, it stats each file: a missing/inaccessible file throws a coded
  `MODEL_FILE_NOT_FOUND` Error (skipping the wasted process spawn and opaque
  stderr); a file smaller than the expected size recorded at import
  (`model_size_bytes` / `mmproj_size_bytes`, absent for local-file imports → size
  check skipped, no false positives) throws `MODEL_FILE_CORRUPT`. A small
  `codedLoadError(code, message)` helper attaches the `code` own-property so the
  web-app's `reportModelLoadError` (`toErrorObject` → `err.code`) maps it to the
  existing actionable toast. Consistency follow-ups: `MODEL_FILE_CORRUPT` added
  to `RECOVERABLE_MODEL_LOAD_CODES`
  ([`telemetry.ts`](web-app/src/lib/telemetry.ts), so a re-downloadable partial
  file is not sent to Sentry as a crash) and to `TERMINAL_LOAD_CODES`
  ([`switchModel.ts`](web-app/src/utils/switchModel.ts), so the auto-start gate
  doesn't loop on a corrupt file that only a manual re-download fixes).
- **Consequences:** Missing/partial model files now fail fast with the actionable
  "re-download"/"delete & re-download" guidance instead of an opaque crash, and
  the backend process is no longer spawned for a model known to be unusable. The
  partial-download case is newly classified as `MODEL_FILE_CORRUPT` (previously
  an unclassified process error). **Deliberately NOT done:** auto re-download on
  missing file (needs a source-URL schema change + download plumbing — larger,
  deferred) and the ATO-116-linked stale-path rewrite (both providers now share
  the `llamacpp/models` tree so the relative `model_path` resolves regardless of
  backend, making it a non-issue in practice). Scope: 2 extension TS files + 2
  web-app files; no Rust, IPC, on-disk layout, or settings-schema change.
  **Verified:** rolldown build clean on both extensions (`dist/index.js`
  221.60 kB upstream / 187.95 kB turboquant, exit 0 — the authoritative compile);
  web-app `tsc -b` clean; `eslint` clean on `switchModel.ts` + `telemetry.ts`.
  Upstream extension vitest: the 4 `backend.test.ts` failures + the
  `index.test.ts`/`autoIncreaseCtx.test.ts` file-level errors are **pre-existing**
  (confirmed by a worktree baseline on parent `6dc54bd39` — identical failing
  files, none touch the new `validateModelArtifacts`/`assertCompleteGguf`); the
  new code path is not covered by the isolated suites (`performLoad` is not
  directly unit-tested, consistent with prior ADRs).
- **Owner:** team.
- **Links:** [ATO-187](https://linear.app/atomicchat/issue/ATO-187),
  [ATO-181](https://linear.app/atomicchat/issue/ATO-181),
  [ATO-116](https://linear.app/atomicchat/issue/ATO-116), the 2026-06-11 ADR
  *Quiet the top-10 Sentry desktop anomalies …* (`MODEL_FILE_CORRUPT` classifier,
  `RECOVERABLE_MODEL_LOAD_CODES`, `TERMINAL_LOAD_CODES`), the 2026-06-11 ADR
  *ATO-135 (web-app slice) …* (`MODEL_FILE_NOT_FOUND` → `modelFileMissing*` toast),
  files:
  [`extensions/llamacpp-upstream-extension/src/index.ts`](extensions/llamacpp-upstream-extension/src/index.ts)
  (`validateModelArtifacts`, `assertCompleteGguf`, `codedLoadError`,
  `ERR_MODEL_FILE_NOT_FOUND`/`ERR_MODEL_FILE_CORRUPT`),
  [`extensions/llamacpp-extension/src/index.ts`](extensions/llamacpp-extension/src/index.ts)
  (mirrored),
  [`web-app/src/lib/telemetry.ts`](web-app/src/lib/telemetry.ts)
  (`RECOVERABLE_MODEL_LOAD_CODES`),
  [`web-app/src/utils/switchModel.ts`](web-app/src/utils/switchModel.ts)
  (`TERMINAL_LOAD_CODES`), Rust classifier
  [`tauri-plugin-llamacpp-upstream/src/error.rs`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/error.rs)
  / [`path.rs`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/path.rs).
