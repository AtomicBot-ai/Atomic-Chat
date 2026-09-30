---
date: 2026-09-17
title: "Text fonts lead the font stacks; the emoji face is carved out of them with `unicode-range`"
---

# 2026-09-17 — Text fonts lead the font stacks; the emoji face is carved out of them with `unicode-range`

- **Context:** Danny's test of the 2.0.39-fixes debug build (macOS, Tauri
 WebKit): "inside buttons the text has shifted, there is visibly less space on
 one side than the other — I think it's the line height". The ATO-526 fix
 (`4e9e55b8a`, 2026-09-15) had put the `AtomicEmoji` face — a `local()`
 colour-emoji family restricted by `unicode-range` to emoji code points — *in
 front of* Inter and StudioFeixenSans in `--font-sans` / `--font-studio`, so a
 ZWJ sequence stays in one font. Blink follows CSS Fonts 4 §5.2 and skips a
 first family whose range excludes U+0020 when it picks the strut font; the
 WebKit that ships in macOS 26 does not: it takes the *first family's face*.
 Measured in an offscreen `WKWebView` on the same Mac with the app's built CSS
 and bundled Inter, `--font-size-base: 16px` (`text-sm` = 14 px on a 20 px
 line): with Inter first, the strut content area is 17 px (ascent 14 / descent
 3) and every label is balanced — "Download" in an `h-9` pill has 12.83 px of
 space above the ink and 12.84 px below, `h-8` 10.67/10.84, `h-10` 14.83/14.84.
 With the emoji face first the strut is Apple Color Emoji's 23 px (18/5), the
 baseline drops 1 px in every 14 px size and the same label sits 13.83 px
 above / 11.84 px below; the `font-studio` dialog title moves 1 px the same way.
 Inter's own metrics are why buttons ever looked right: ascent − cap height =
 0.9688 − 0.7275 = 0.2412 = descent, so capitals sit dead-centre in its content
 area. `ascent-override` / `descent-override` on the emoji face would have been
 the one-block fix, but WebKit ignores those descriptors (measured: identical to
 the broken state). Plain reordering restores the metrics but hands U+2764 back
 to Inter (bare ❤ measured 14.22 px = Inter's glyph) and U+263A to
 StudioFeixenSans — the two symbols the ATO-526 comment warned about, and on
 Linux exactly the split it fixed.
- **Decision:** `--font-sans: "Inter", "AtomicEmoji", sans-serif` and
 `--font-studio: "StudioFeixenSans", "AtomicEmoji"`. Every Inter (18) and
 StudioFeixenSans (7) `@font-face` declares a `unicode-range` that is the exact
 complement of the `AtomicEmoji` range, so the text font is the first family
 — the strut font in every engine — while every emoji code point still falls
 through to the emoji face. `styles/__tests__/font-stack.test.ts` holds the
 two lists together: text faces lead both stacks, each text face includes
 U+0020, is disjoint from the emoji range, and the union covers U+0000–U+10FFFF.
 `button.tsx` is untouched: its anatomy (`h-9 px-4 py-2`, `inline-flex
 items-center`, `text-sm`) centres a 20 px line box exactly; the shift was the
 baseline inside that box.
- **Consequences:** WebKit (macOS, Linux) gets Inter's strut back — measured
 identical to the pre-`4e9e55b8a` numbers to the hundredth of a pixel in every
 button size and in the dialog title — and every ZWJ sequence in the probe
 (🏴‍☠️, ❤️‍🔥, 🧑‍❤️‍🧑, 🙋‍♂️, 🏳️‍⚧️, 🧑‍✈️) still measures as one 19 px glyph, with
 bare ❤ still coming from the emoji face as it does in the shipped build.
 Blink (Windows WebView2) never had the shift and is unchanged. The 25 text
 faces each carry the same 18-range list; widening the emoji set means editing
 it and the complement together, which the test enforces. Left as is:
 `styles/markdown.css` keeps `'AtomicEmoji', monospace` for code, because a
 generic family cannot carry a `unicode-range`; code text in WebKit therefore
 keeps the 1 px-low baseline inside its 1.6 line height, where it is not
 visible. Not covered here: `ascent-override` on the emoji face would become
 a smaller fix the day WebKit implements the descriptor.
- **Owner:** team.
- **Links:** files: [`web-app/src/index.css`](../../web-app/src/index.css),
 [`web-app/src/styles/font.css`](../../web-app/src/styles/font.css),
 [`web-app/src/styles/__tests__/font-stack.test.ts`](../../web-app/src/styles/__tests__/font-stack.test.ts);
 ATO-526 (the emoji face); commit `4e9e55b8a` (introduced the emoji-first
 order); WebKit `FontCascadeFonts::primaryFont` (main now cites CSS Fonts 4
 §5.2, the shipping build does not).
