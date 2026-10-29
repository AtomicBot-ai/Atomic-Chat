import { describe, expect, it } from 'vitest'

import enHub from '@/locales/en/hub.json'
import enProviders from '@/locales/en/providers.json'
import ruHub from '@/locales/ru/hub.json'
import ruProviders from '@/locales/ru/providers.json'

// The GenieX screens read every text from the `geniex` block, so a key missing in one language
// shows its key path instead of a sentence (change add-geniex-runtime: en and ru; other locales
// fall back to en).

type Block = { [key: string]: string | Block }

function leaves(block: Block, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  for (const [key, value] of Object.entries(block)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') out.set(path, value)
    else for (const [p, v] of leaves(value, path)) out.set(p, v)
  }
  return out
}

const placeholders = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort()

describe('the GenieX texts', () => {
  it.each([
    ['providers', enProviders, ruProviders],
    ['hub', enHub, ruHub],
  ])('%s.json has the same keys and placeholders in en and ru', (_file, enJson, ruJson) => {
    const en = leaves((enJson as unknown as Record<string, Block>).geniex)
    const ru = leaves((ruJson as unknown as Record<string, Block>).geniex ?? {})

    expect(en.size).toBeGreaterThan(0)
    expect([...ru.keys()].sort()).toEqual([...en.keys()].sort())
    for (const [key, text] of en) {
      expect(placeholders(ru.get(key) ?? ''), key).toEqual(placeholders(text))
    }
  })

  it('names every device and chip the lists may carry', () => {
    const hub = (enHub as unknown as { geniex: { device: Record<string, string>; chipLabel: Record<string, string> } }).geniex
    expect(Object.keys(hub.device).sort()).toEqual(['cpu', 'gpu', 'hybrid', 'npu'])
    expect(Object.keys(hub.chipLabel).sort()).toEqual(['x-elite', 'x2-elite'])
  })
})
