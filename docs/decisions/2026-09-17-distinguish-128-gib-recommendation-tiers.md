---
date: 2026-09-17
title: "Distinguish nominal 128 GiB and larger recommendation tiers"
---

# 2026-09-17 — Distinguish nominal 128 GiB and larger recommendation tiers

- **Context:** The two memory ladders ended in `64_plus`; 64, 96, 128 and 192 GiB machines all received the same Qwen3.6 35B Q4 offer. Product requested concrete high-memory choices and equivalent vision options.
- **Decision:** Retain every existing id and split the top into legacy `64_plus`, nominal `128`, and `128_plus`. The 128 band is [127, 129) GiB for VRAM and [127.5, 128.5) for unified memory, allowing modest firmware reporting tolerance. Existing lower boundaries, largest-single-GPU selection, CPU-only behavior and memory-fit rules stay intact. Use ordered lead/vision/other options in both the manifest and bundled baseline: Qwen3.6 35B Q6 at 64, Qwen3 Coder Next Q4 between 64 and 128, gpt-oss 120B Q8 at 128, Nemotron 3 Super 120B Q4 above 128. Gemma 4 31B Q4/Q6/Q8 plus F16 projector supplies the vision options.
- **Consequences:** Old clients still understand `64_plus` and ignore the added keys; keep schema version 1 and ship this client before publishing the manifest. New clients work offline with verified cards, complete shard sizes and pinned projectors. Choices come from the local staff-picks catalog, with exact sizes/revisions/LFS hashes from official HF metadata in the test fixture. The 50% comfortable threshold and 85% macOS load ceiling describe estimated fit, not measured quality or throughput. All options clear the ceiling even at each bucket's lower edge. AtomicChat Qwen3.6 mirrors have no mmproj, so they are text-only choices here. Long-context and backend smoke testing still require the real app/hardware.
- **Owner:** team.
- **Links:** `web-app/src/lib/hardware-tier.ts`; `web-app/src/constants/__tests__/fixtures/high-tier-files.json`; companion `atomic-chat-conf` branch `danny/tiers-64-128`, `models/recommended.json` and `models/schema.json`.
