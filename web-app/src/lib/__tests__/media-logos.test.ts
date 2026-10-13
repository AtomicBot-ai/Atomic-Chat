import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { isMonochromeFamilyLogo, modelFamilyLogoSrc } from '@/lib/model-logo'
import { getProviderLogo } from '@/lib/utils'
import type { MediaCatalogView } from '@/services/media/types'
import fixture from './media-catalog.fixture.json'

// A trimmed snapshot of the core's built-in media catalog (atomic-chat-core
// `src/media/catalog-baseline.json`): every provider and model the pickers can show.
const catalog = fixture as unknown as MediaCatalogView

const publicFile = (src: string) =>
  existsSync(resolve(__dirname, '../../../public', `.${src}`))

const models = Object.entries(catalog.providers).flatMap(([provider, section]) =>
  (['image', 'video'] as const).flatMap((kind) =>
    (section[kind]?.models ?? []).map((model) => ({ provider, kind, model }))
  )
)

describe('media provider logos', () => {
  it.each(Object.keys(catalog.providers))('%s has a bundled logo', (provider) => {
    const src = getProviderLogo(provider)
    expect(src, provider).toBeDefined()
    expect(publicFile(src as string), src).toBe(true)
  })
})

describe('media model brand marks', () => {
  it.each(models.map(({ provider, kind, model }) => [`${provider} ${kind} ${model.id}`, model]))(
    '%s has a brand mark',
    (_label, model) => {
      const src = modelFamilyLogoSrc(model.id) ?? modelFamilyLogoSrc(model.name)
      expect(src, model.id).not.toBeNull()
      expect(publicFile(src as string), src as string).toBe(true)
    }
  )

  it('tints the single-colour marks it added, so they show on a dark theme', () => {
    for (const src of ['/svg/runway.svg', '/svg/pika.svg', '/svg/ideogram.svg', '/svg/recraft.svg']) {
      expect(isMonochromeFamilyLogo(src), src).toBe(true)
    }
  })
})
