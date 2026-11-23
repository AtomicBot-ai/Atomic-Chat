import { describe, expect, it } from 'vitest'

import enChat from '../../locales/en/chat.json'
import frChat from '../../locales/fr/chat.json'
import ruChat from '../../locales/ru/chat.json'
import enApi from '../../locales/en/api.json'
import frApi from '../../locales/fr/api.json'
import ruApi from '../../locales/ru/api.json'

// History compaction's copy: the divider, the popover's button, the error
// card's action, the toasts and the Local API Server row. English, French
// (kept complete, see locale-fr-parity) and Russian carry every key with the
// same placeholders, plural forms included. Other languages fall back to
// English.
const CHAT_KEYS = [
  'contextCompaction.dividerTitle',
  'contextCompaction.dividerTokens',
  'contextCompaction.showSummary',
  'contextCompaction.hideSummary',
  'contextCompaction.compact',
  'contextCompaction.compactHint',
  'contextCompaction.failed',
  'contextCompaction.nothing',
  'turnRecovery.compactAndRetry',
  'turnRecovery.contextOverflowCompactMessage',
]
const CHAT_PLURALS = [
  'contextCompaction.dividerMessages',
  'contextCompaction.done',
  'contextCompaction.failedTrimmed',
]
const API_KEYS = ['notice.historyCompacted']
const API_PLURALS = ['notice.historyCompactedDetail']

const FORMS: Record<string, string[]> = {
  en: ['one', 'other'],
  fr: ['one', 'other'],
  ru: ['one', 'few', 'many', 'other'],
}

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

const tables = {
  chat: { en: enChat, fr: frChat, ru: ruChat },
  api: { en: enApi, fr: frApi, ru: ruApi },
}

describe('history compaction copy', () => {
  it.each([
    ...CHAT_KEYS.map((key) => ['chat', key] as const),
    ...API_KEYS.map((key) => ['api', key] as const),
  ])('%s:%s is translated with the same placeholders', (ns, key) => {
    const english = lookup(tables[ns].en, key)
    expect(typeof english).toBe('string')
    for (const lng of ['fr', 'ru'] as const) {
      const text = lookup(tables[ns][lng], key)
      expect(typeof text, lng).toBe('string')
      expect(placeholders(text), lng).toEqual(placeholders(english))
    }
  })

  it.each([
    ...CHAT_PLURALS.map((key) => ['chat', key] as const),
    ...API_PLURALS.map((key) => ['api', key] as const),
  ])('%s:%s has every plural form of each language', (ns, key) => {
    const english = lookup(tables[ns].en, `${key}_other`)
    expect(typeof english).toBe('string')
    for (const lng of ['en', 'fr', 'ru'] as const) {
      for (const form of FORMS[lng]) {
        const text = lookup(tables[ns][lng], `${key}_${form}`)
        expect(typeof text, `${lng} ${form}`).toBe('string')
        expect(placeholders(text), `${lng} ${form}`).toEqual(
          placeholders(english)
        )
      }
    }
  })
})
