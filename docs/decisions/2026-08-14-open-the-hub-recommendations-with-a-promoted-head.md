---
date: 2026-08-14
title: "Open the Hub recommendations with a promoted head ahead of the family grouping"
---

# 2026-08-14 — Open the Hub recommendations with a promoted head ahead of the family grouping

- **Context:** The curated Hub list is ordered by model family — Qwen, then Gemma, then
  LFM, then everything else — and `staff-picks-registry.test.ts` pins that sequence, so
  the first thirteen rows are fixed by family regardless of what shipped this week. Four
  new GGUF repos had to be the first thing a user sees in `/hub`:
  `AtomicChat/Muse-Glimmer-30B-GGUF`, `AtomicChat/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-GGUF`,
  `LiquidAI/LFM2.5-2.6B-GGUF` and `AtomicChat/Ling-3.0-flash-GGUF`. Only the LFM one belongs
  to a promoted family, and even it would have landed behind the LFM models already listed,
  so under the old invariant none of them could open the list.

- **Decision:** Keep the family grouping, but let a small hand-picked head sit in front of
  it. Picks with `order` below `10` — the order of the first family entry — are that head;
  the family sequence starts at `10` and is unchanged. The grouping test now checks the
  list from `order >= 10` onwards instead of from the first row.

- **Consequences:**
  - Promoting or rotating a launch model is a manifest edit (`order: 1..9`) and needs no
    client release, same as the rest of the curated order.
  - The head is not itself ordered by any rule, so it must stay short: it is the one part
    of the list where "why is this first" has no answer beyond curation. Anything that
    outlives its release moment should move into its family group.
  - `owao/Nanbeige4.2-3B-GGUF` is listed in the family region (`order: 167`, right below
    Bonsai) rather than the head, and sits outside the scraped catalog orgs, so it resolves
    through the single Hugging Face call in `useStaffPicks` rather than from
    `catalog.json`. That path already exists for long-tail picks; the cost is one request
    on first open of the Hub.
  - Nanbeige is served by `llamacpp-upstream` only: the arch (`LLM_ARCH_NANBEIGE`) is in
    upstream `llama.cpp` master but not in the pinned `atomic-llama-cpp-turboquant`
    release (`b10018-1.3.0`), so a user who switched to the fork provider will not load
    it. Upstream is the default provider on every desktop platform, so the default path
    works.
  - Ling 3.0 flash needs the fork provider: `bailingmoe3` is in upstream llama.cpp, but the
    published quants rely on TurboQuant's fixes on top of it. It is listed anyway because
    the fork is a supported provider on every desktop platform, and the smallest usable
    rung is 32 GB, so the device filter hides the row from machines that could not run it
    in the first place.
  - Muse Glimmer carries no bundled brand mark of its own and is published from Meta's
    weights, so it reuses the `meta` icon key. Ling and Nanbeige come from labs with no mark
    in the `@lobehub/icons-static-svg` set, so they follow the `prism-ml` precedent and
    bundle the Hugging Face avatar of the lab that trained the model — `inclusionai`,
    `nanbeige` — as a 200x200 WebP in `public/images/model-provider/`. The mark follows the
    model's origin, not the account that published the quants, so a repo re-quantized by
    someone else keeps the same row art.

- **Owner:** `team`
- **Links:**
  - `atomic-chat-conf`: `models/staff-picks.json`
  - `web-app/src/constants/staff-picks.ts`,
    `web-app/src/services/__tests__/staff-picks-registry.test.ts`
  - Family grouping it amends:
    [Serve Hub staff picks from a separate manifest and rebuild /hub as a split view](2026-08-06-serve-hub-staff-picks-from-a-separate-manifest-and-split-view.md)
