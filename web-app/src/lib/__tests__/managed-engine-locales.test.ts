import { describe, expect, it } from 'vitest'

import enHub from '@/locales/en/hub.json'
import enProviders from '@/locales/en/providers.json'
import ruHub from '@/locales/ru/hub.json'
import ruProviders from '@/locales/ru/providers.json'

import { SGLANG_ENGINE, VLLM_ENGINE } from '../managed-engines'

// The shared managed-engine screens read every text from the engine's own block (`ManagedEngine.i18n`),
// so a missing key shows its key path instead of a sentence. SGLang's blocks are vLLM's, key for key,
// with the same placeholders (change add-sglang-runtime, task 3.2: en and ru; other locales fall back
// to en).

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

const FILES = [
  ['en', 'providers', enProviders],
  ['en', 'hub', enHub],
  ['ru', 'providers', ruProviders],
  ['ru', 'hub', ruHub],
] as const

describe('the SGLang texts', () => {
  it.each(FILES)('%s/%s.json has the full sglang block, with vLLM’s keys and placeholders', (_locale, _file, json) => {
    const blocks = json as unknown as Record<string, Block>
    const vllm = leaves(blocks[VLLM_ENGINE.i18n])
    const sglang = leaves(blocks[SGLANG_ENGINE.i18n] ?? {})

    expect([...sglang.keys()].sort()).toEqual([...vllm.keys()].sort())
    for (const [key, text] of vllm) {
      expect(placeholders(sglang.get(key) ?? ''), key).toEqual(placeholders(text))
    }
  })

  it.each(FILES)('%s/%s.json names SGLang, never vLLM, in the sglang block', (_locale, _file, json) => {
    const sglang = leaves((json as unknown as Record<string, Block>)[SGLANG_ENGINE.i18n] ?? {})
    const texts = [...sglang.values()]

    expect(texts.length).toBeGreaterThan(0)
    expect(texts.filter((text) => /vLLM/.test(text))).toEqual([])
    expect(texts.some((text) => text.includes('SGLang'))).toBe(true)
  })
})
