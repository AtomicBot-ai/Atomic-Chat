import { describe, expect, it } from 'vitest'

import enErrors from '@/locales/en/model-errors.json'
import enSettings from '@/locales/en/settings.json'
import jaErrors from '@/locales/ja/model-errors.json'
import jaSettings from '@/locales/ja/settings.json'
import koErrors from '@/locales/ko/model-errors.json'
import koSettings from '@/locales/ko/settings.json'

// The MLX engine install (the provider page's card, the Hub button, the
// failure toasts and the first load's "Install") reads these keys; en, ja and
// ko carry each of them with the same placeholders.

type Block = { [key: string]: string | Block }

const read = (block: Block, path: string): string | undefined => {
  let current: string | Block | undefined = block
  for (const key of path.split('.')) {
    if (!current || typeof current === 'string') return undefined
    current = current[key]
  }
  return typeof current === 'string' ? current : undefined
}

const placeholders = (text: string | undefined) =>
  [...(text ?? '').matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort()

const SETTINGS_KEYS = [
  'mlxEngine.notInstalled',
  'mlxEngine.installingEngine',
  'mlxEngine.installFailed',
  'mlxEngine.setup.description',
  'mlxEngine.setup.size',
  'mlxEngine.setup.install',
  'mlxEngine.setup.progress',
  'mlxEngine.setup.failed',
]
const ERROR_KEYS = [
  'mlxEngineMissingTitle',
  'mlxEngineMissingDescription',
  'mlxEngineMissingAction',
]

describe('the MLX engine install texts', () => {
  it.each([
    ['settings', SETTINGS_KEYS, enSettings, [jaSettings, koSettings]],
    ['model-errors', ERROR_KEYS, enErrors, [jaErrors, koErrors]],
  ] as const)(
    '%s.json has every key in en, ja and ko with the same placeholders',
    (_file, keys, en, translations) => {
      for (const key of keys) {
        const source = read(en as unknown as Block, key)
        expect(source, key).toBeTruthy()
        for (const translation of translations) {
          const text = read(translation as unknown as Block, key)
          expect(text, key).toBeTruthy()
          expect(placeholders(text), key).toEqual(placeholders(source))
        }
      }
    }
  )
})
