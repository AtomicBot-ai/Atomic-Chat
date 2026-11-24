import { describe, expect, it } from 'vitest'

import en from '../../locales/en/assistants.json'
import fr from '../../locales/fr/assistants.json'
import ru from '../../locales/ru/assistants.json'

// "Up to N on this device" under the context slider. English, French (kept
// complete, see locale-fr-parity) and Russian carry both forms with the same
// placeholders; other languages fall back to English.
const KEYS: Record<string, string[]> = {
  contextSizeDeviceMax: ['{{size}}'],
  contextSizeDeviceMaxBelowTrained: ['{{size}}', '{{trained}}'],
}

describe.each([
  ['en', en],
  ['fr', fr],
  ['ru', ru],
] as const)('%s device context hint', (_lng, table) => {
  it.each(Object.entries(KEYS))('%s keeps its placeholders', (key, slots) => {
    const text = (table as Record<string, unknown>)[key]
    expect(typeof text).toBe('string')
    for (const slot of slots) expect(text).toContain(slot)
  })
})
