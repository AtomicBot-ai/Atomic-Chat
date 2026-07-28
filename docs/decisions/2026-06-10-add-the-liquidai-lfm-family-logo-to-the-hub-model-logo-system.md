---
date: 2026-06-10
title: "Add the LiquidAI (LFM) family logo to the Hub model-logo system + render monochrome brand marks via a theme-safe CSS mask (ATO-138)"
---

# 2026-06-10 — Add the LiquidAI (LFM) family logo to the Hub model-logo system + render monochrome brand marks via a theme-safe CSS mask (ATO-138)

- **Context:** In Hub model search, LFM models (LiquidAI's *Liquid Foundation
  Models*) showed letter placeholders instead of a brand icon — e.g.
  `LFM2.5-8B-A1B-GGUF` by Unsloth → `U`, by LiquidAI → `L`,
  `LFM2-24B-A2B-MLX-{4,5,6}bit` by Lmstudio-Community → `L`
  ([ATO-138](https://linear.app/atomicchat/issue/ATO-138), v1.1.106). Root
  cause: the family-logo registry in
  [`web-app/src/lib/model-logo.ts`](web-app/src/lib/model-logo.ts) only
  recognized deepseek / gemma / qwen / llama / mistral; LFM matched nothing, so
  [`ModelLogo`](web-app/src/containers/ModelLogo.tsx) fell back to the first
  letter of the author. The same-family models showed *different* letters
  because the fallback keys on the quantizer (Unsloth / LiquidAI /
  Lmstudio-Community), not the family. The system matches on the model **name
  family** by design (so a community repack still shows the brand mark), exactly
  per the issue's "show family logo, keep letter only as fallback".
- **Decision:** Extend the existing local-asset family-logo mechanism (no remote
  avatar fetch — that constraint is preserved). Two facets:
  1. **Asset + rule.** Bundle the official LiquidAI brand mark (from
     `@lobehub/icons`, the same set the other `*-color.svg` logos follow) at
     [`web-app/public/svg/liquid.svg`](web-app/public/svg/liquid.svg) and add a
     `/lfm/i → /svg/liquid.svg` rule to `FAMILY_LOGO_RULES`.
  2. **Theme-safe monochrome render.** The Liquid mark is single-color
     (`fill="currentColor"`, brand black); painted as a plain `<img>` it would
     be near-invisible on the dark-theme tile (`dark:bg-input/30`). So
     `model-logo.ts` now also exports `isMonochromeFamilyLogo(src)` (backed by a
     `MONOCHROME_FAMILY_LOGOS` set), and `ModelLogo` renders such marks through a
     CSS `mask-image` span tinted with `currentColor` (`text-foreground`) — so
     they inherit a theme-aware color, mirroring the letter they replace. Colored
     marks keep the existing `<img>` path (with its `onError` letter fallback).
     `modelFamilyLogoSrc` keeps its `string | null` signature, so the other
     consumer ([`SetupScreen.tsx`](web-app/src/containers/SetupScreen.tsx),
     curated recs only — never LFM) is untouched.
- **Consequences:** LFM models now show the LiquidAI mark regardless of who
  quantized them; the letter remains the genuine fallback when no family logo
  matches. Adding future monochrome brands is a two-line change (drop the SVG,
  add it to the rules + the mono set); colored brands need only a rule. Scope:
  web-app only (one new asset + two edited files); no Rust, IPC, schema, or
  persistence change, and no remote fetch. Lint-clean on both edited files.
- **Owner:** team.
- **Links:** [ATO-138](https://linear.app/atomicchat/issue/ATO-138),
  [@lobehub/icons](https://github.com/lobehub/lobe-icons) (Liquid mark source),
  files: [`web-app/public/svg/liquid.svg`](web-app/public/svg/liquid.svg),
  [`web-app/src/lib/model-logo.ts`](web-app/src/lib/model-logo.ts)
  (`FAMILY_LOGO_RULES`, `isMonochromeFamilyLogo`),
  [`web-app/src/containers/ModelLogo.tsx`](web-app/src/containers/ModelLogo.tsx)
  (mono CSS-mask render path).
