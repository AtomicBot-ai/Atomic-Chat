---
date: 2026-09-11
title: "One rule keeps speculative-decoding heads out of both model import paths"
---

# 2026-09-11 — One rule keeps speculative-decoding heads out of both model import paths

- **Context:** the Hub listing dropped MTP heads (`isMtpCompanionFile`) and
  non-weight GGUFs (`isNonWeightGgufFile`); the local cache scan called only the
  second. A 97 MB `mtp-gemma-4-E2B-it.gguf` in an HF cache was therefore offered
  as a model and died in llama-server with "Gemma4Assistant requires ctx_other
  to be set" (ATO-523). Neither predicate caught the drafts the app itself
  downloads: `dflash` was anchored to the start of the name while every
  published draft carries it mid-name (`Qwen3.6-27B-DFlash.Q8_0`), and Gemma 4's
  `…-it-assistant` heads matched nothing. A test even pinned
  `Qwen3.5-9B-DFlash.Q8_0.gguf` as a model.
- **Decision:** `isNonWeightGgufFile` is the one name rule both paths use. It
  now covers MTP heads, `dflash` as a token anywhere in the name, and
  `assistant` in a Gemma 4 name. The local scan also drops a GGUF whose
  `general.architecture` is `gemma4-assistant`, `dflash` or `eagle3` (names
  read from the bundled libllama and from drafts on disk), which catches a head
  whatever it was renamed to. The rule is tested against every filename in
  `gemmaMtpRegistry.ts` and `dflashRegistry.ts`, exported for that as
  `GEMMA_MTP_DRAFT_FILENAMES` / `DFLASH_DRAFT_FILENAMES`.
- **Consequences:** Hub repos that hold only drafts (`AtomicChat/*-DFlash-GGUF`,
  `…-it-assistant-GGUF`) offer nothing to download; drafts are fetched by the
  MTP / DFlash toggles straight from the registries. A full model genuinely
  named `…DFlash…` or `gemma-4-…-assistant` would be hidden too; none is known.
  A new draft family needs its name token here and its architecture in
  `NON_TEXT_GGUF_ARCHITECTURES`. The load-error popup still leads with the
  benign `--fit` warning instead of the fatal line; that is not addressed here.
- **Owner:** `team`
- **Links:** ATO-523; `web-app/src/lib/models.ts` (`isNonWeightGgufFile`),
  `web-app/src/services/models/localScan.ts`,
  `web-app/src/services/models/default.ts`; tests in
  `web-app/src/lib/__tests__/models.test.ts` and
  `web-app/src/services/models/__tests__/localScan.test.ts`
