import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The emoji face (`AtomicEmoji`) exists so a ZWJ sequence stays in one font
// (ATO-526). WebKit — the Tauri webview on macOS and Linux — takes the strut
// metrics of every line box from the *first* family's face, even when that
// face's `unicode-range` excludes U+0020, so an emoji face in front of Inter
// drops every label by 1 px (the emoji font's content area is 23 px at 14 px
// against Inter's 17 px). The text fonts therefore lead both stacks, and the
// emoji code points are carved out of the text faces with a `unicode-range`
// that is the exact complement of the emoji face's range. These tests hold the
// two lists together: a code point claimed by neither, or by both, is a bug.

const fontCss = readFileSync(join(__dirname, '../font.css'), 'utf8')
const indexCss = readFileSync(join(__dirname, '../../index.css'), 'utf8')

const LAST_CODE_POINT = 0x10ffff

type Face = { family: string; descriptors: Record<string, string> }

function fontFaces(css: string): Face[] {
  const faces: Face[] = []
  for (const block of css.matchAll(/@font-face\s*{([^}]*)}/g)) {
    const descriptors: Record<string, string> = {}
    for (const declaration of block[1].matchAll(/([a-z-]+)\s*:\s*([^;]+);/g)) {
      descriptors[declaration[1]] = declaration[2].replace(/\s+/g, ' ').trim()
    }
    const family = descriptors['font-family']?.replace(/['"]/g, '') ?? ''
    faces.push({ family, descriptors })
  }
  return faces
}

/** `U+0-200C, U+2764, …` → sorted, merged [from, to] intervals. */
function intervals(unicodeRange: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const token of unicodeRange.split(',')) {
    const match = token
      .trim()
      .match(/^U\+([0-9A-Fa-f]{1,6})(?:-([0-9A-Fa-f]{1,6}))?$/)
    if (!match) throw new Error(`unsupported unicode-range token "${token}"`)
    const from = parseInt(match[1], 16)
    const to = match[2] ? parseInt(match[2], 16) : from
    out.push([from, to])
  }
  out.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const [from, to] of out) {
    const last = merged[merged.length - 1]
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to)
    else merged.push([from, to])
  }
  return merged
}

function covers(ranges: Array<[number, number]>, codePoint: number): boolean {
  return ranges.some(([from, to]) => codePoint >= from && codePoint <= to)
}

function families(stack: string): string[] {
  return stack.split(',').map((family) => family.trim().replace(/['"]/g, ''))
}

function themeStack(name: string): string[] {
  const match = indexCss.match(new RegExp(`--${name}:\\s*([^;]+);`))
  if (!match) throw new Error(`--${name} is not defined in index.css`)
  return families(match[1])
}

const faces = fontFaces(fontCss)
const emojiFace = faces.find((face) => face.family === 'AtomicEmoji')
const textFaces = faces.filter(
  (face) => face.family === 'Inter' || face.family === 'StudioFeixenSans'
)

describe('font stacks: the text font leads, the emoji face follows', () => {
  it('lists Inter before AtomicEmoji in --font-sans', () => {
    const stack = themeStack('font-sans')
    expect(stack[0]).toBe('Inter')
    expect(stack).toContain('AtomicEmoji')
  })

  it('lists StudioFeixenSans before AtomicEmoji in --font-studio', () => {
    const stack = themeStack('font-studio')
    expect(stack[0]).toBe('StudioFeixenSans')
    expect(stack).toContain('AtomicEmoji')
  })
})

describe('font faces: the emoji range is carved out of every text face', () => {
  it('has the faces this test is about', () => {
    expect(emojiFace).toBeDefined()
    expect(textFaces.map((face) => face.family)).toEqual([
      ...Array(18).fill('Inter'),
      ...Array(7).fill('StudioFeixenSans'),
    ])
  })

  it('keeps U+0020 out of the emoji face and the carried symbols in it', () => {
    const emoji = intervals(emojiFace!.descriptors['unicode-range'])
    expect(covers(emoji, 0x20)).toBe(false)
    // Inter carries U+2764 (heavy black heart) and StudioFeixenSans carries
    // U+263A (white smiling face); both open RGI ZWJ sequences, so the emoji
    // face has to win them or the sequence splits across two fonts.
    expect(covers(emoji, 0x2764)).toBe(true)
    expect(covers(emoji, 0x263a)).toBe(true)
  })

  it.each(textFaces.map((face, index) => [index, face] as const))(
    'text face #%i declares the exact complement of the emoji range',
    (_index, face) => {
      const unicodeRange = face.descriptors['unicode-range']
      expect(
        unicodeRange,
        `${face.family} ${face.descriptors.src}`
      ).toBeDefined()
      const text = intervals(unicodeRange)
      const emoji = intervals(emojiFace!.descriptors['unicode-range'])

      // The text face keeps the space, so it stays the strut font everywhere.
      expect(covers(text, 0x20)).toBe(true)

      // Disjoint: no code point is claimed by both faces …
      for (const [from, to] of emoji) {
        for (const [textFrom, textTo] of text) {
          expect(
            from > textTo || to < textFrom,
            `U+${from.toString(16)}-${to.toString(16)} overlaps U+${textFrom.toString(16)}-${textTo.toString(16)}`
          ).toBe(true)
        }
      }

      // … and together they cover every code point, with no gap.
      const union = intervals(
        `${unicodeRange}, ${emojiFace!.descriptors['unicode-range']}`
      )
      expect(union).toEqual([[0, LAST_CODE_POINT]])
    }
  )
})
