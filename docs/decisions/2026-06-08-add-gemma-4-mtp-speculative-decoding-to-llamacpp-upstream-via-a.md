---
date: 2026-06-08
title: "Add Gemma 4 MTP speculative decoding to `llamacpp-upstream` via a separate draft head (PR #23398; closes ATO-88 head 2)"
---

# 2026-06-08 — Add Gemma 4 MTP speculative decoding to `llamacpp-upstream` via a separate draft head (PR #23398; closes ATO-88 head 2)

- **Context:** Upstream `ggml-org/llama.cpp` merged Gemma 4 Multi-Token
  Prediction ([PR #23398](https://github.com/ggml-org/llama.cpp/pull/23398),
  commit `04eb4c4`, first tagged release **`b9553`**). This was the
  remaining blocker on **head 2 of [ATO-88](https://linear.app/atomicchat/issue/ATO-88)**
  ("llama.cpp Gemma 4 MTP GGUF", previously upstream-blocked). Unlike Qwen
  3.6 built-in MTP — where the head lives *inside* the same GGUF and we just
  pass `--spec-type draft-mtp` (gate `MTP_MIN_BUILD=9180`,
  [`args.rs`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/args.rs)) —
  Gemma 4 ships the MTP head as a **separate draft GGUF** loaded via
  `--model-draft <head>`. Upstream MTP support covers **only Gemma 4 31B
  (dense) and 26B-A4B (MoE)**; the E2B/E4B drafter was deferred upstream and
  12B has no head. The same `b9553` bump also fixes plain Gemma 4 GGUF
  loading and unblocks QAT (ATO-101/99) — that bundle bump is owned
  separately; here we only encode the runtime wiring and a version gate.
- **Decision:** Wire Gemma 4 MTP end-to-end in the **`llamacpp-upstream`**
  provider, reusing the existing provider-level `mtp` toggle and
  distinguishing the two shapes by the presence of a draft path:
  1. **Head registry** (NEW
     [`extensions/llamacpp-upstream-extension/src/gemmaMtpRegistry.ts`](extensions/llamacpp-upstream-extension/src/gemmaMtpRegistry.ts)):
     static target→head map with HF-API-verified `sha256` + `size`.
     **31B → `am17an/Gemma4-31B-it-GGUF` / `mtp-gemma-4-31B-it.gguf`** (the
     PR author's reference head). **26B-A4B →
     `AtomicChat/gemma-4-26B-A4B-it-assistant-GGUF` /
     `gemma-4-26B-A4B-it-assistant.Q8_0.gguf`** — am17an published *no* 26B
     repo (the plan's `am17an/Gemma4-26B-A4B-it-GGUF` does not exist), so we
     point at our **first-party** head, which is model-identical to the
     upstream reference (the 31B AtomicChat `Q8_0` head matches am17an's head
     byte-size) and guaranteed-stable as our own org. `barozp/*-mtp-BF16` and
     any 12B/E2B/E4B head are deliberately **not** supported.
  2. **Extension** ([`index.ts`](extensions/llamacpp-upstream-extension/src/index.ts)):
     new `mtp_draft_path` field in `model.yml`; `ensureGemmaMtpDraft(modelId)`
     downloads the head (idempotent, sha256/size-validated, via
     `@janhq/download-extension`) into
     `<jan>/llamacpp/models/<id>/mtp-draft.gguf` and records the relative
     path in `model.yml`; `performLoad` resolves it to an absolute
     `cfg.mtp_draft_path` only when `cfg.mtp` is on. **Lazy resolution:** if
     `cfg.mtp` is on, the model is a Gemma 4 31B/26B-A4B target, and no
     `mtp_draft_path` is recorded yet, `performLoad` calls
     `ensureGemmaMtpDraft` itself (then re-reads `model.yml`) — so the single
     "Enable MTP" toggle is robust even when it was flipped on with no Gemma
     model active (a download failure is logged and the load proceeds
     text-only, never crashing). `checkGemmaMtpSupport` exposes the registry to
     the UI.
  3. **Rust** ([`args.rs`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/args.rs)):
     new `#[serde(default)] mtp_draft_path: String`; new constant
     **`GEMMA_MTP_MIN_BUILD=9553`**; `add_mtp_args` now branches — with a
     draft path it emits `--model-draft <path> --spec-type draft-mtp
     --spec-draft-n-max 4` gated on `9553`; without one it keeps the Qwen
     path (`--spec-type draft-mtp --spec-draft-n-max 2`, gate `9180`)
     unchanged. **KV-quant guard:** when a draft path is set and `cache_type_k/v`
     is non-`f16`, we `log::warn!` (PR #23398 reviewers reported q8_0 KV +
     Vulkan dropping draft acceptance to ~0) — we warn, we do not override the
     user's KV choice.
  4. **guest-js** (`types.ts` + `normalizeLlamacppConfig`): `mtp_draft_path`
     added to `LlamacppConfig` and `ModelConfig`.
  5. **UI** ([`$providerName.tsx`](web-app/src/routes/settings/providers/$providerName.tsx)):
     `handleToggleLlamacppMtp` gains a Gemma branch — if the active model
     isn't Qwen-MTP (`id` contains "mtp"), it calls `checkGemmaMtpSupport`;
     on a Gemma target it downloads the head (`ensureGemmaMtpDraft`) before
     writing `mtp=true` and reloading; otherwise the existing
     `LlamacppMtpUnsupportedDialog` is shown (now also lists the two Gemma
     targets). New i18n keys `llamacppMtpDownloadingDraft` /
     `llamacppMtpGemmaSupported*` (EN + RU).
- **Consequences:**
  - Gemma 4 **31B** and **26B-A4B** get MTP speculative decoding on
    `llamacpp-upstream` once the bundle is `>= b9553`; on older bundles the
    Gemma path is skipped with a `warn!` (no broken flag passed to
    `llama-server`). Qwen built-in MTP is untouched (separate gate, no
    `--model-draft`). MoE (26B-A4B) gains may be marginal — expected.
  - The MTP head is small (~460–515 MB) and shares the existing model-folder
    download/validation path; both providers share the GGUF tree
    (`MODELS_PROVIDER_ROOT='llamacpp'`) so the head lives beside the target.
  - **Deviation from the plan:** the plan named `am17an/Gemma4-26B-A4B-it-GGUF`
    as the 26B source; it does not exist on HF. Verified-real first-party
    `AtomicChat/gemma-4-26B-A4B-it-assistant-GGUF` is used instead (no
    fabricated repo). macOS turboquant `llamacpp` provider, MLX, and Windows
    are unaffected (this is the upstream provider; the bundle gate keeps it
    inert until `b9553`).
  - **Verification:** new `args.rs` unit tests cover the Gemma path
    (`--model-draft` + n-max 4 at b9553, skipped below b9553, Qwen path
    unaffected, embedding-mode skip). Runtime validation on a `>= b9553`
    bundle (draft acceptance > 0 on 31B) is pending that bundle bump
    (ATO-101).
- **Owner:** team.
- **Links:** [PR #23398](https://github.com/ggml-org/llama.cpp/pull/23398),
  [ATO-88](https://linear.app/atomicchat/issue/ATO-88),
  [ATO-101](https://linear.app/atomicchat/issue/ATO-101),
  [ATO-99](https://linear.app/atomicchat/issue/ATO-99), §4.2 *LLM backend*,
  files: [`gemmaMtpRegistry.ts`](extensions/llamacpp-upstream-extension/src/gemmaMtpRegistry.ts),
  [`index.ts`](extensions/llamacpp-upstream-extension/src/index.ts),
  [`args.rs`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/args.rs),
  [`guest-js/types.ts`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/guest-js/types.ts),
  [`$providerName.tsx`](web-app/src/routes/settings/providers/$providerName.tsx),
  [`LlamacppMtpUnsupportedDialog.tsx`](web-app/src/containers/dialogs/LlamacppMtpUnsupportedDialog.tsx).
