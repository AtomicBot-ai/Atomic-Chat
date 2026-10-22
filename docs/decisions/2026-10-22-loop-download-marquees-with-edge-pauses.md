---
date: 2026-10-22
title: "Loop download marquees continuously with edge pauses"
---

# 2026-10-22 — Loop download marquees continuously with edge pauses

- **Context:** the initial overflowing-name/status marquee reached the end and jumped back to its beginning. The requested motion is a repeated text ribbon with a visible gap.
- **Decision:** supersede only the animation policy in `2026-10-22-show-complete-download-progress-on-restart.md`. Render a second visual copy after a 32px gap only when the original copy exceeds its viewport. Scroll left at 30px/s. Pause for 1.5s with the original first glyph at the left edge and for 1.5s with its last glyph at the right edge, then continue until the next copy occupies the original position. Reset at that visually identical boundary and repeat. The numerical percentage and action controls remain outside the animated viewport.
- **Accessibility:** the repeated visual copy is aria-hidden and does not duplicate DOM text or the accessible name. Short copy has neither a duplicate nor an animation.
- **Verification:** Chromium seeks into both pause phases and across the loop boundary, checks edge alignment within one pixel, confirms the fixed percentage and panel bounds, and covers Medium/Extra Large fonts in both themes. Download accounting, native transport, payloads and manual pause intent are unchanged.
