---
date: 2026-10-22
title: "Count completed download shards during startup recovery"
---

# 2026-10-22 — Count completed download shards during startup recovery

- **Context:** startup discovery counted partial sidecars but missed completed GGUF shards whose sidecars were removed. Resume then included those bytes, making the displayed amount jump. Long download names and retry/size readouts were clipped.
- **Decision:** read completed payload lengths in the same unfinished GGUF directory, count each target once even if stale partial sidecars remain, and retain the journal's whole-request total when discovery cannot determine every remaining file. This is read-only accounting, not a checksum or permission to import an incomplete model. Source validation and paused intent remain unchanged.
- **UI:** scroll overflowing download names and status suffixes at 30 pixels/second with 1.5-second pauses at both ends, then repeat from the beginning. Keep the numeric percentage and actions outside the animated viewport; short copy stays still. Width observation and font readiness recalculate overflow without restarting equal-width progress updates.
- **Verification:** fixture tests cover completed shards, orphan completed projectors, duplicate stale sidecars and whole-request totals. Chromium geometry tests cover fixed percentages, animated suffixes, short copy, both themes and Medium/Extra Large fonts. Use the existing manually paused download for a read-only app restart acceptance check.
