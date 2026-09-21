---
date: 2026-09-17
title: "Wrap chat code within a consistent padded surface"
---

# 2026-09-17 — Wrap chat code within a consistent padded surface

- **Context:** Markdown removed the fenced code body's horizontal padding, and both Markdown and shared tool code retained intrinsic-width, non-wrapping code. Long PowerShell paths, CSV rows and single tokens created horizontal scrolling.
- **Decision:** Give chat fences a 1rem inset and use `white-space: pre-wrap` plus `overflow-wrap: anywhere` on code and highlighted spans. Bound the code box and hide horizontal overflow on chat code wrappers; tool previews retain vertical scrolling. Apply the same wrapping to the shared CodeBlock, including the existing HTML artifact caller, which already requests wrapping and numbered lines. Leave independent editors alone.
- **Consequences:** Soft wraps change only presentation; highlighting, original indentation/newlines, clipboard text, downloads and controls remain intact. Chromium tests measure visible glyph bounds, first-line inset and scroll widths at Medium/Extra Large and narrow/desktop widths in both themes. Numbered artifact rows keep their existing layout without extra blank lines.
- **Owner:** team.
- **Links:** [Markdown styles](../../web-app/src/styles/markdown.css), [shared CodeBlock](../../web-app/src/components/ai-elements/code-block.tsx), [browser regressions](../../web-app/src/containers/RenderMarkdown.layout.test.tsx).
