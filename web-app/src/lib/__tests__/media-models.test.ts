import { describe, expect, it } from 'vitest'

import {
  catalogModels,
  describeMediaModel,
  isMediaConnected,
  mediaDialectOf,
  mediaModelsOf,
  mediaToSeed,
  offersMedia,
  withMediaModel,
  withListedModels,
  withoutMediaModel,
} from '@/lib/media-models'
import type { MediaCatalogView } from '@/services/media/types'
import fixture from './media-catalog.fixture.json'

const catalog = fixture as unknown as MediaCatalogView

const provider = (patch: Partial<ProviderObject> = {}): ProviderObject =>
  ({
    provider: 'openai',
    active: true,
    api_key: 'sk-test',
    base_url: 'https://api.openai.com/v1',
    settings: [],
    models: [],
    ...patch,
  }) as ProviderObject

describe('mediaModelsOf', () => {
  it('lists the enabled models of one kind', () => {
    const p = provider({
      media: {
        models: [
          { id: 'a', kind: 'image' },
          { id: 'b', kind: 'video' },
        ],
      },
    })
    expect(mediaModelsOf(p, 'image').map((m) => m.id)).toEqual(['a'])
    expect(mediaModelsOf(p, 'video').map((m) => m.id)).toEqual(['b'])
    expect(mediaModelsOf(provider(), 'image')).toEqual([])
  })
})

describe('mediaDialectOf / offersMedia', () => {
  it('reads the catalog for a known provider', () => {
    expect(mediaDialectOf(provider(), 'image', catalog)).toBe('openai-images')
    expect(mediaDialectOf(provider(), 'video', catalog)).toBeUndefined()
    expect(offersMedia(provider(), catalog)).toBe(true)
  })

  it("prefers a custom server's own adapter over the catalog", () => {
    const custom = provider({
      provider: 'my-box',
      media: { image_api: 'a1111', models: [] },
    })
    expect(mediaDialectOf(custom, 'image', catalog)).toBe('a1111')
    expect(mediaDialectOf(custom, 'image', null)).toBe('a1111')
  })

  it('offers nothing for a chat-only provider', () => {
    expect(offersMedia(provider({ provider: 'anthropic' }), catalog)).toBe(
      false
    )
    expect(offersMedia(provider(), null)).toBe(false)
  })
})

describe('isMediaConnected', () => {
  const media = { models: [{ id: 'gpt-image-2', kind: 'image' as const }] }

  it('needs enabled models and a key', () => {
    expect(isMediaConnected(provider({ media }))).toBe(true)
    expect(isMediaConnected(provider({ media, api_key: '  ' }))).toBe(false)
    expect(isMediaConnected(provider({ media: { models: [] } }))).toBe(false)
    expect(isMediaConnected(provider())).toBe(false)
  })

  it('takes a keyless server of the user’s own', () => {
    expect(
      isMediaConnected(
        provider({
          provider: 'automatic1111',
          api_key: '',
          base_url: 'http://127.0.0.1:7860',
          media_only: true,
          media,
        })
      )
    ).toBe(true)
  })
})

describe('seeding', () => {
  const keys = (media: ProviderMedia | undefined) =>
    (media?.models ?? []).map((m) => `${m.kind}:${m.id}`)

  it("lists every curated catalog model, each kind's default first", () => {
    const models = catalogModels('openrouter', catalog)
    const images = models.filter((m) => m.kind === 'image')
    const videos = models.filter((m) => m.kind === 'video')
    expect(images).toHaveLength(
      catalog.providers.openrouter?.image?.models.length ?? -1
    )
    expect(videos).toHaveLength(
      catalog.providers.openrouter?.video?.models.length ?? -1
    )
    expect(images[0]?.id).toBe(
      catalog.providers.openrouter?.image?.models.find((m) => m.default)?.id
    )
    expect(models[0]?.kind).toBe('image')
    expect(catalogModels('anthropic', catalog)).toEqual([])
  })

  it('gives a provider all its curated models before any key is in', () => {
    const seeded = mediaToSeed(provider({ api_key: '' }), catalog, true)
    expect(keys(seeded)).toEqual([
      'image:gpt-image-2.5-flare',
      'image:gpt-image-2.5-sunburst',
      'image:gpt-image-2',
    ])
    expect(seeded?.offered).toEqual(keys(seeded))
  })

  it('never puts back a model the user removed, and adds the ones conf adds later', () => {
    const seeded = mediaToSeed(provider(), catalog, true)
    const trimmed = withoutMediaModel(seeded, 'gpt-image-2', 'image')
    expect(
      mediaToSeed(provider({ media: trimmed }), catalog, true)
    ).toBeUndefined()
    expect(
      mediaToSeed(
        provider({ media: { models: [], offered: trimmed.offered } }),
        catalog,
        true
      )
    ).toBeUndefined()

    const grown = structuredClone(catalog)
    grown.providers.openai?.image?.models.push({
      ...grown.providers.openai.image.models[0]!,
      id: 'gpt-image-3',
      default: false,
    })
    const next = mediaToSeed(provider({ media: trimmed }), grown, true)
    expect(keys(next)).toEqual([
      'image:gpt-image-2.5-flare',
      'image:gpt-image-2.5-sunburst',
      'image:gpt-image-3',
    ])
    expect(next?.offered).toContain('image:gpt-image-2')
  })

  it('completes a list kept from before the app tracked what it offered', () => {
    const legacy = {
      image_api: 'openai-images' as const,
      models: [{ id: 'gpt-image-2.5-flare', kind: 'image' as const }],
    }
    const next = mediaToSeed(provider({ media: legacy }), catalog, true)
    expect(next?.image_api).toBe('openai-images')
    expect(keys(next)).toEqual([
      'image:gpt-image-2.5-flare',
      'image:gpt-image-2.5-sunburst',
      'image:gpt-image-2',
    ])
  })

  it('waits for a keyless server to answer, and offers nothing without a catalog', () => {
    expect(
      mediaToSeed(provider({ provider: 'ollama' }), catalog, false)
    ).toBeUndefined()
    expect(
      keys(mediaToSeed(provider({ provider: 'ollama' }), catalog, true))
    ).toEqual(['image:x/z-image-turbo', 'image:x/flux2-klein'])
    expect(
      mediaToSeed(provider({ provider: 'anthropic' }), catalog, true)
    ).toBeUndefined()
    expect(
      mediaToSeed(provider({ provider: 'sdcpp-server' }), catalog, true)
    ).toBeUndefined()
    expect(mediaToSeed(provider(), null, true)).toBeUndefined()
  })

  it("adds a server's listed models it does not hold yet", () => {
    const media = {
      image_api: 'a1111' as const,
      models: [{ id: 'a', kind: 'image' as const }],
    }
    expect(
      withListedModels(media, [
        { id: 'a', kind: 'image', name: 'A' },
        { id: 'b', kind: 'image', name: 'B' },
      ])
    ).toEqual({
      image_api: 'a1111',
      models: [
        { id: 'a', kind: 'image' },
        { id: 'b', kind: 'image', name: 'B' },
      ],
    })
    expect(withListedModels(undefined, [{ id: 'x', kind: 'image' }])).toEqual({
      models: [{ id: 'x', kind: 'image' }],
    })
  })
})

describe('withMediaModel / withoutMediaModel', () => {
  it('adds, replaces by id and kind, and removes', () => {
    const one = withMediaModel(undefined, { id: 'x', kind: 'image' })
    expect(one).toEqual({ models: [{ id: 'x', kind: 'image' }] })
    const renamed = withMediaModel(one, { id: 'x', kind: 'image', name: 'X' })
    expect(renamed.models).toEqual([{ id: 'x', kind: 'image', name: 'X' }])
    const both = withMediaModel(
      { ...renamed, image_api: 'a1111' },
      { id: 'x', kind: 'video' }
    )
    expect(both.image_api).toBe('a1111')
    expect(both.models).toHaveLength(2)
    expect(withoutMediaModel(both, 'x', 'image')).toEqual({
      image_api: 'a1111',
      models: [{ id: 'x', kind: 'video' }],
    })
    expect(withoutMediaModel(undefined, 'x', 'image')).toEqual({ models: [] })
  })
})

describe('describeMediaModel', () => {
  it('finds the catalog descriptor', () => {
    const d = describeMediaModel(
      provider(),
      { id: 'gpt-image-2', kind: 'image' },
      catalog
    )
    expect(d).toMatchObject({
      id: 'gpt-image-2',
      kind: 'image',
      source: 'catalog',
    })
  })

  it('prefers the live listing', () => {
    const listed = [
      {
        id: 'gpt-image-2',
        name: 'Listed',
        kind: 'image' as const,
        api: 'openai-images' as const,
        workflows: ['create' as const],
        params: {},
        source: 'live' as const,
      },
    ]
    const d = describeMediaModel(
      provider(),
      { id: 'gpt-image-2', kind: 'image' },
      catalog,
      listed
    )
    expect(d?.name).toBe('Listed')
  })

  it('falls back to the dialect defaults for a model the catalog does not know', () => {
    const d = describeMediaModel(
      provider(),
      { id: 'gpt-image-9', kind: 'image', name: 'Nine' },
      catalog
    )
    expect(d).toMatchObject({
      id: 'gpt-image-9',
      name: 'Nine',
      api: 'openai-images',
      source: 'live',
    })
    expect(d?.workflows.length).toBeGreaterThan(0)
  })

  it('describes a custom server’s video model with its own adapter', () => {
    const custom = provider({
      provider: 'box',
      media: { video_api: 'openai-videos', models: [] },
    })
    const d = describeMediaModel(custom, { id: 'clip', kind: 'video' }, null)
    expect(d).toMatchObject({
      kind: 'video',
      api: 'openai-videos',
      workflows: ['create'],
    })
  })

  it('knows nothing of a provider without an adapter', () => {
    expect(
      describeMediaModel(
        provider({ provider: 'anthropic' }),
        { id: 'x', kind: 'image' },
        catalog
      )
    ).toBeUndefined()
  })
})
