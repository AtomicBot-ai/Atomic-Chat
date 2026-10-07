import { describe, expect, it } from 'vitest'
import {
  filterFamiliesBySearch,
  familyIsInstalled,
  isHubCategory,
  mediaFamilies,
  splitByInstalled,
} from '@/lib/hub-media'
import type {
  DiffusionCatalog,
  DiffusionCatalogFamily,
} from '@/services/diffusion-catalog-registry'

const familyFixture = (
  id: string,
  extra: Partial<DiffusionCatalogFamily> = {}
): DiffusionCatalogFamily =>
  ({
    id,
    name: id,
    modality: 'image',
    engines: ['sdcpp'],
    transformer: {
      repo: `owner/${id}-GGUF`,
      quants: [
        { id: 'q4_k', label: 'Q4_K', filename: `${id}-Q4_K.gguf`, bytes: 1 },
        { id: 'q8_0', label: 'Q8_0', filename: `${id}-Q8_0.gguf`, bytes: 2 },
      ],
    },
    text_encoders: [],
    ...extra,
  }) as DiffusionCatalogFamily

const catalogOf = (families: DiffusionCatalogFamily[]): DiffusionCatalog =>
  ({ schema_version: 1, families }) as DiffusionCatalog

describe('isHubCategory', () => {
  it('accepts the five categories and nothing else', () => {
    expect(
      ['chat', 'image', 'video', 'decision', 'embedding'].every(isHubCategory)
    ).toBe(true)
    expect([undefined, '', 'images', 'audio', 1].some(isHubCategory)).toBe(
      false
    )
  })
})

describe('mediaFamilies', () => {
  it('keeps the families of one modality the sd.cpp engine can run', () => {
    const catalog = catalogOf([
      familyFixture('z-image'),
      familyFixture('wan', { modality: 'video' }),
      familyFixture('diffusers-only', { engines: ['diffusers'] }),
      familyFixture('empty', {
        transformer: { repo: 'owner/empty', quants: [] },
      }),
      familyFixture('flux.1-schnell'),
    ])

    expect(mediaFamilies(catalog, 'image').map((f) => f.id)).toEqual([
      'z-image',
      'flux.1-schnell',
    ])
    expect(mediaFamilies(catalog, 'video').map((f) => f.id)).toEqual(['wan'])
  })

  it('is empty until the catalog has loaded', () => {
    expect(mediaFamilies(null, 'image')).toEqual([])
  })
})

describe('filterFamiliesBySearch', () => {
  const families = [
    familyFixture('flux.1-schnell', {
      name: 'FLUX.1 schnell',
      developer: 'Black Forest Labs',
    }),
    familyFixture('z-image', {
      name: 'Z-Image Turbo',
      developer: 'Tongyi-MAI',
      description: 'Fast 6B text-to-image model',
    }),
  ]

  it('returns every family for a blank query', () => {
    expect(filterFamiliesBySearch(families, '   ')).toHaveLength(2)
  })

  it('matches name, developer, description and repo, ignoring case', () => {
    const ids = (query: string) =>
      filterFamiliesBySearch(families, query).map((f) => f.id)

    expect(ids('FLUX')).toEqual(['flux.1-schnell'])
    expect(ids('forest')).toEqual(['flux.1-schnell'])
    expect(ids('text-to-image')).toEqual(['z-image'])
    expect(ids('z-image-gguf')).toEqual(['z-image'])
  })

  it('needs every word of the query to match', () => {
    expect(
      filterFamiliesBySearch(families, 'turbo tongyi').map((f) => f.id)
    ).toEqual(['z-image'])
    expect(filterFamiliesBySearch(families, 'turbo forest')).toEqual([])
  })
})

describe('splitByInstalled', () => {
  it('puts families with any quant on disk first, each group in catalog order', () => {
    const families = [
      familyFixture('a'),
      familyFixture('b'),
      familyFixture('c'),
      familyFixture('d'),
    ]
    const installedIds = new Set(['d:q4_k', 'b:q8_0'])

    const { installed, available } = splitByInstalled(families, installedIds)

    expect(installed.map((f) => f.id)).toEqual(['b', 'd'])
    expect(available.map((f) => f.id)).toEqual(['a', 'c'])
  })

  it('does not count an artifact of another family', () => {
    expect(
      familyIsInstalled(familyFixture('a'), new Set(['ab:q4_k', 'a:q2_k']))
    ).toBe(false)
  })
})
