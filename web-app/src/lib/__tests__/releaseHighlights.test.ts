import { describe, expect, it } from 'vitest'

import {
  parseReleaseHighlights,
  splitHighlight,
} from '@/lib/releaseHighlights'

/// Shaped like what `scripts/release-notes/generate.py` actually publishes.
const RELEASE_BODY = `## 🚀 New Features

- Windows support — Atomic Chat is now available on Windows
- Image generation. Run Stable Diffusion locally from the Images page

## 🔧 Improvements & Fixes

- 10+ stability and UI fixes
- Faster model loading: cold starts drop by about a third
- Smaller installer

## 🙏 Contributors

- @someone made their first contribution in [#12](https://example.test/12)
`

describe('splitHighlight', () => {
  it('honours an explicit bold headline', () => {
    expect(splitHighlight('**1.2-1.7x faster diffusion.** AMD 20% perf boost'))
      .toEqual({
        headline: '1.2-1.7x faster diffusion.',
        detail: 'AMD 20% perf boost',
      })
  })

  it('splits on the first sentence when there are several', () => {
    expect(
      splitHighlight('Image generation. Run Stable Diffusion locally')
    ).toEqual({
      headline: 'Image generation.',
      detail: 'Run Stable Diffusion locally',
    })
  })

  it('splits on an em dash', () => {
    expect(
      splitHighlight('Windows support — Atomic Chat is now available on Windows')
    ).toEqual({
      headline: 'Windows support',
      detail: 'Atomic Chat is now available on Windows',
    })
  })

  it('splits on a colon', () => {
    expect(
      splitHighlight('Faster model loading: cold starts drop by a third')
    ).toEqual({
      headline: 'Faster model loading',
      detail: 'cold starts drop by a third',
    })
  })

  it('keeps a short bullet whole', () => {
    expect(splitHighlight('Smaller installer')).toEqual({
      headline: 'Smaller installer',
    })
  })

  it('strips links and inline code', () => {
    expect(
      splitHighlight('Fixed [the crash](https://example.test/1) in `load()`')
    ).toEqual({ headline: 'Fixed the crash in load()' })
  })

  it('rejects a bullet that is only markup', () => {
    expect(splitHighlight('   ')).toBeNull()
  })
})

describe('parseReleaseHighlights', () => {
  it('collects bullets across feature sections and counts the overflow', () => {
    const result = parseReleaseHighlights(RELEASE_BODY, 2)

    expect(result.items).toEqual([
      {
        headline: 'Windows support',
        detail: 'Atomic Chat is now available on Windows',
      },
      {
        headline: 'Image generation.',
        detail: 'Run Stable Diffusion locally from the Images page',
      },
    ])
    // Five product bullets, two shown — the contributor bullet is not one.
    expect(result.remaining).toBe(3)
  })

  it('skips the contributors section', () => {
    const all = parseReleaseHighlights(RELEASE_BODY, 50)
    expect(all.items).toHaveLength(5)
    expect(
      all.items.some((item) => item.headline.includes('@someone'))
    ).toBe(false)
    expect(all.remaining).toBe(0)
  })

  it('ignores nested bullets, which only repeat their parent', () => {
    const body = '## Fixes\n\n- Top level\n  - A nested detail\n'
    expect(parseReleaseHighlights(body).items).toEqual([
      { headline: 'Top level' },
    ])
  })

  it('returns nothing for a body with no bullets at all', () => {
    expect(parseReleaseHighlights('Just a paragraph of prose.')).toEqual({
      items: [],
      remaining: 0,
    })
  })

  it('tolerates a missing body', () => {
    expect(parseReleaseHighlights(undefined)).toEqual({
      items: [],
      remaining: 0,
    })
    expect(parseReleaseHighlights(null)).toEqual({ items: [], remaining: 0 })
  })
})
