import { describe, expect, it } from 'vitest'

import en from '../../locales/en/chat.json'
import fr from '../../locales/fr/chat.json'
import ru from '../../locales/ru/chat.json'

// The context statuses and the context-overflow copy that left the code for
// the locales: English, French (kept complete, see locale-fr-parity) and
// Russian carry every key with the same placeholders. Other languages fall
// back to English.
const KEYS = [
  'contextActivity.expanding',
  'contextActivity.expandingPending',
  'contextActivity.restarting',
  'contextActivity.compacting',
  'contextActivity.reading',
  'turnRecovery.contextOverflowTitle',
  'turnRecovery.contextOverflowMessage',
  'turnRecovery.contextOverflowShortenMessage',
  'turnRecovery.increaseContext',
  'turnRecovery.contextAtMax',
]

const lookup = (table: unknown, key: string): unknown =>
  key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object'
          ? (node as Record<string, unknown>)[part]
          : undefined,
      table
    )

const placeholders = (text: unknown) =>
  [...String(text).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort()

describe('context activity copy', () => {
  it.each(KEYS)('%s is translated with the same placeholders', (key) => {
    const english = lookup(en, key)
    expect(typeof english).toBe('string')
    for (const table of [fr, ru]) {
      const text = lookup(table, key)
      expect(typeof text).toBe('string')
      expect(placeholders(text)).toEqual(placeholders(english))
    }
  })
})
