import { describe, expect, it } from 'vitest'

import enProviders from '@/locales/en/providers.json'
import ruProviders from '@/locales/ru/providers.json'

// The LiteRT-LM screens read every text from the `liteRtLm` block, so a key missing in one language
// shows its key path instead of a sentence (change add-litert-lm-runtime: en and ru; other locales
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

describe('the LiteRT-LM texts', () => {
  it.each([['providers', enProviders, ruProviders]])(
    '%s.json has the same keys and placeholders in en and ru',
    (_file, enJson, ruJson) => {
      const en = leaves((enJson as unknown as Record<string, Block>).liteRtLm)
      const ru = leaves((ruJson as unknown as Record<string, Block>).liteRtLm ?? {})

      expect(en.size).toBeGreaterThan(0)
      expect([...ru.keys()].sort()).toEqual([...en.keys()].sort())
      for (const [key, text] of en) {
        expect(placeholders(ru.get(key) ?? ''), key).toEqual(placeholders(text))
      }
    }
  )
})
