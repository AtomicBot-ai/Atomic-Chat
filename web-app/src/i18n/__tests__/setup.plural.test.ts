import { describe, it, expect, afterEach } from 'vitest'

import i18n from '@/i18n/setup'

const ns = 'pluraltest'

describe('i18n plural forms', () => {
  const original = i18n.language

  afterEach(() => {
    i18n.language = original
    for (const lng of ['en', 'ru']) delete i18n.resources[lng][ns]
  })

  it('picks the plural form for the count and falls back to the bare key', () => {
    i18n.resources.en[ns] = {
      items_one: '{{count}} item',
      items_other: '{{count}} items',
      bare: '{{count}} things',
    }
    i18n.language = 'en'

    expect(i18n.t(`${ns}:items`, { count: 1 })).toBe('1 item')
    expect(i18n.t(`${ns}:items`, { count: 3 })).toBe('3 items')
    expect(i18n.t(`${ns}:bare`, { count: 1 })).toBe('1 things')
  })

  it('uses the language rules, and English forms when the language lacks the key', () => {
    i18n.resources.en[ns] = {
      items_one: '{{count}} item',
      items_other: '{{count}} items',
    }
    i18n.resources.ru[ns] = {
      items_one: '{{count}} элемент',
      items_few: '{{count}} элемента',
      items_many: '{{count}} элементов',
    }
    i18n.language = 'ru'

    expect(i18n.t(`${ns}:items`, { count: 21 })).toBe('21 элемент')
    expect(i18n.t(`${ns}:items`, { count: 3 })).toBe('3 элемента')
    expect(i18n.t(`${ns}:items`, { count: 5 })).toBe('5 элементов')
    // 1.5 is "other" in Russian, which this table lacks: English decides.
    expect(i18n.t(`${ns}:items`, { count: 1.5 })).toBe('1.5 items')
  })
})
