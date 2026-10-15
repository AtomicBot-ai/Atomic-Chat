import { describe, expect, it } from 'vitest'

import {
  isPrismDownloadOnly,
  parseHubFileUrl,
  planPrismSetup,
  prismFamilyCard,
  prismFamilyCards,
  prismTagBuild,
  requiresPrism,
  routeForVerdict,
  type PrismPlanInput,
} from '@/lib/model-setup'
import type {
  CompatibilityOutcome,
  CompatibilityVerdict,
  PrismCatalog,
  PrismFamily,
} from '@/services/model-setup/types'

const verdict = (
  outcome: CompatibilityOutcome,
  provider: string | null = null
): CompatibilityVerdict => ({
  outcome,
  provider,
  requires: [],
  evidence: 'rules',
  rules_version: 1,
  reason: 'r',
})

describe('parseHubFileUrl', () => {
  it.each([
    [
      'https://huggingface.co/prism-ml/Bonsai-8B-gguf/resolve/main/Bonsai-8B-PQ2_0.gguf',
      {
        repo: 'prism-ml/Bonsai-8B-gguf',
        file: 'Bonsai-8B-PQ2_0.gguf',
        revision: 'main',
      },
    ],
    [
      'https://huggingface.co/o/r/resolve/abc123/sub/dir/f%20x.gguf?download=true',
      { repo: 'o/r', file: 'sub/dir/f x.gguf', revision: 'abc123' },
    ],
    ['https://example.test/o/r/resolve/main/f.gguf', null],
    ['https://huggingface.co/o/r/blob/main/f.gguf', null],
    ['https://huggingface.co/o/r/resolve/main', null],
    ['/Users/me/models/f.gguf', null],
  ])('%s', (url, expected) => {
    expect(parseHubFileUrl(url)).toEqual(expected)
  })
})

describe('routeForVerdict', () => {
  it.each([
    [verdict('engine_required', 'atomic-prism'), 'setup'],
    [verdict('engine_update_required', 'atomic-prism'), 'setup'],
    [verdict('compatible', 'atomic-prism'), 'setup'],
    [verdict('compatible'), 'download'],
    [verdict('compatible', 'llamacpp-upstream'), 'download'],
    [verdict('legacy_artifact'), 'refuse'],
    [verdict('unsupported'), 'refuse'],
    [verdict('inspection_required'), 'download'],
  ] as const)('%o → %s', (input, expected) => {
    expect(routeForVerdict(input)).toBe(expected)
  })

  it('marks only the files that need PrismML', () => {
    expect(requiresPrism(verdict('engine_required', 'atomic-prism'))).toBe(true)
    expect(requiresPrism(verdict('compatible'))).toBe(false)
    expect(requiresPrism(verdict('legacy_artifact'))).toBe(false)
    expect(requiresPrism(null)).toBe(false)
    expect(requiresPrism(undefined)).toBe(false)
  })
})

describe('Bonsai families as Hub cards', () => {
  const family = (over: Partial<PrismFamily> = {}): PrismFamily => ({
    id: 'ternary-bonsai-2-27b',
    title: 'Ternary Bonsai 2 27B',
    repo: 'prism-ml/Ternary-Bonsai-2-27B-gguf',
    revision: 'b072e1d',
    files: [
      {
        file: 'Ternary-Bonsai-2-27B-PTQ1_0.gguf',
        size: 5_946_648_928,
        sha256: 'a'.repeat(64),
        treatment: 'prism_required',
      },
      {
        file: 'Ternary-Bonsai-2-27B-PQ2_0.gguf',
        size: 7_206_168_928,
        sha256: 'b'.repeat(64),
        treatment: 'prism_required',
        default: true,
      },
    ],
    projectors: [
      {
        file: 'Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf',
        size: 629_246_976,
        sha256: 'c'.repeat(64),
        default: true,
      },
    ],
    ...over,
  })

  it('offers the recommended file first, pinned to the family revision', () => {
    const card = prismFamilyCard(family())

    expect(card).toMatchObject({
      model_name: 'prism-ml/Ternary-Bonsai-2-27B-gguf',
      developer: 'prism-ml',
      description: 'Ternary Bonsai 2 27B',
      num_quants: 2,
    })
    expect(card.quants?.map((q) => q.model_id)).toEqual([
      'prism-ml/Ternary-Bonsai-2-27B-PQ2_0',
      'prism-ml/Ternary-Bonsai-2-27B-PTQ1_0',
    ])
    expect(card.quants?.[0]).toMatchObject({
      path: 'https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf/resolve/b072e1d/Ternary-Bonsai-2-27B-PQ2_0.gguf',
      file_size: '6.7 GB',
    })
    expect(card.mmproj_models?.[0].file_size).toBe('600.1 MB')
    // The URL is what the verdict and the setup read the file from.
    expect(parseHubFileUrl(card.quants![0].path)).toEqual({
      repo: 'prism-ml/Ternary-Bonsai-2-27B-gguf',
      file: 'Ternary-Bonsai-2-27B-PQ2_0.gguf',
      revision: 'b072e1d',
    })
  })

  it('lists the featured families first', () => {
    const cards = prismFamilyCards([
      family({ id: 'a', repo: 'prism-ml/Bonsai-8B-gguf' }),
      family({ id: 'b', featured: true }),
    ])

    expect(cards.map((c) => c.model_name)).toEqual([
      'prism-ml/Ternary-Bonsai-2-27B-gguf',
      'prism-ml/Bonsai-8B-gguf',
    ])
  })
})

describe('prismTagBuild', () => {
  it.each([
    ['prism-b9100-1234567', 9100],
    ['prism-b9100', 0],
    ['b9100', 0],
  ])('%s → %d', (tag, build) => {
    expect(prismTagBuild(tag)).toBe(build)
  })
})

describe('planPrismSetup: what a Bonsai download takes, from what the core reports', () => {
  const repo = 'prism-ml/Bonsai-8B-gguf'
  const family: PrismFamily = {
    id: 'bonsai-8b',
    title: 'Bonsai 8B',
    repo,
    revision: 'b072e1d',
    files: [
      {
        file: 'Bonsai-8B-PQ2_0.gguf',
        size: 2_000,
        sha256: 'a'.repeat(64),
        treatment: 'prism_required',
        default: true,
      },
    ],
    projectors: [
      { file: 'mmproj-F16.gguf', size: 900, sha256: 'b'.repeat(64) },
      {
        file: 'mmproj-Q8_0.gguf',
        size: 500,
        sha256: 'c'.repeat(64),
        default: true,
      },
    ],
  }
  const catalog = (over: Partial<PrismCatalog> = {}): PrismCatalog => ({
    installed: [],
    available: [
      { version: 'prism-b9000-abcdef0', backend: 'macos-arm64', order: 1 },
      { version: 'prism-b9100-1234567', backend: 'macos-arm64', order: 2 },
    ],
    recommended: 'prism-b9100-1234567/macos-arm64',
    releases: [
      {
        tag: 'prism-b9100-1234567',
        variants: [{ id: 'macos-arm64', size: 30 }],
      },
      {
        tag: 'prism-b9000-abcdef0',
        variants: [{ id: 'macos-arm64', size: 20 }],
      },
    ],
    ...over,
  })
  const request = {
    repo,
    file: 'Bonsai-8B-PQ2_0.gguf',
    revision: 'main',
    model_id: 'prism-ml/Bonsai-8B-PQ2_0',
    include_projector: true,
  }
  const input = (over: Partial<PrismPlanInput> = {}): PrismPlanInput => ({
    request,
    verdict: verdict('engine_required', 'atomic-prism'),
    families: [family],
    catalog: catalog(),
    freeBytes: 1_000_000,
    ...over,
  })

  it('installs the recommended build and downloads the model and its default projector at the pinned revision', () => {
    const plan = planPrismSetup(input())

    expect(plan.model_id).toBe('prism-ml/Bonsai-8B-PQ2_0')
    expect(plan.engine).toEqual({
      version: 'prism-b9100-1234567',
      backend: 'macos-arm64',
      installed: false,
      download_size: 30,
    })
    expect(plan.model).toEqual({
      file: 'Bonsai-8B-PQ2_0.gguf',
      url: `https://huggingface.co/${repo}/resolve/b072e1d/Bonsai-8B-PQ2_0.gguf`,
      size: 2_000,
      sha256: 'a'.repeat(64),
    })
    expect(plan.projector).toEqual({
      file: 'mmproj-Q8_0.gguf',
      url: `https://huggingface.co/${repo}/resolve/b072e1d/mmproj-Q8_0.gguf`,
      size: 500,
      sha256: 'c'.repeat(64),
    })
    expect(plan.offers_projector).toBe(true)
    expect(plan.total_download_bytes).toBe(30 + 2_000 + 500)
    expect(plan.free_bytes).toBe(1_000_000)
    expect(plan.blockers).toEqual([])
    expect(isPrismDownloadOnly(plan)).toBe(false)
  })

  it('leaves the projector out when image support is off, and still offers it', () => {
    const plan = planPrismSetup(
      input({ request: { ...request, include_projector: false } })
    )

    expect(plan.projector).toBeNull()
    expect(plan.offers_projector).toBe(true)
    expect(plan.total_download_bytes).toBe(30 + 2_000)
  })

  it('takes no build older than the file needs', () => {
    const plan = planPrismSetup(
      input({
        verdict: {
          ...verdict('engine_update_required', 'atomic-prism'),
          min_prism_build: 9050,
        },
        catalog: catalog({ recommended: 'prism-b9000-abcdef0/macos-arm64' }),
      })
    )

    expect(plan.engine).toMatchObject({
      version: 'prism-b9100-1234567',
      backend: 'macos-arm64',
    })
  })

  it('counts nothing to download for a build already on disk', () => {
    const plan = planPrismSetup(
      input({
        catalog: catalog({
          installed: [
            { version: 'prism-b9100-1234567', backend: 'macos-arm64' },
          ],
        }),
      })
    )

    expect(plan.engine).toMatchObject({ installed: true, download_size: 0 })
    expect(plan.total_download_bytes).toBe(2_000 + 500)
    expect(isPrismDownloadOnly(plan)).toBe(true)
  })

  it('downloads only the files for a model PrismML already runs', () => {
    const plan = planPrismSetup(
      input({
        verdict: {
          ...verdict('compatible', 'atomic-prism'),
          installed_prism_build: 9000,
        },
        catalog: catalog({
          installed: [
            { version: 'prism-b9100-1234567', backend: 'macos-arm64' },
            { version: 'prism-b9000-abcdef0', backend: 'macos-arm64' },
          ],
        }),
      })
    )

    expect(plan.engine).toEqual({
      version: 'prism-b9000-abcdef0',
      backend: 'macos-arm64',
      installed: true,
      download_size: 0,
    })
    expect(isPrismDownloadOnly(plan)).toBe(true)
  })

  it('is blocked when no offered build is new enough', () => {
    const plan = planPrismSetup(
      input({
        verdict: {
          ...verdict('engine_update_required', 'atomic-prism'),
          min_prism_build: 9999,
        },
      })
    )

    expect(plan.engine).toBeNull()
    expect(plan.blockers).toEqual([{ code: 'no_engine_build' }])
    expect(isPrismDownloadOnly(plan)).toBe(false)
  })

  it('is blocked when the drive cannot take the download', () => {
    const plan = planPrismSetup(input({ freeBytes: 1_000 }))

    expect(plan.blockers).toEqual([
      { code: 'insufficient_disk_space', needed: 2_530, free: 1_000 },
    ])
  })

  it('passes on what the core refused the file for', () => {
    expect(
      planPrismSetup(input({ verdict: verdict('unsupported') })).blockers
    ).toEqual([{ code: 'unsupported', message: 'r' }])
    expect(
      planPrismSetup(
        input({
          verdict: { ...verdict('legacy_artifact'), replacement: 'v2.gguf' },
        })
      ).blockers
    ).toEqual([{ code: 'legacy_artifact', message: 'r', replacement: 'v2.gguf' }])
  })

  it('downloads a file the families do not list as it is, with no projector', () => {
    const plan = planPrismSetup(
      input({
        request: { ...request, file: 'Other.gguf', revision: undefined },
        catalog: catalog({ releases: undefined }),
      })
    )

    expect(plan.model).toEqual({
      file: 'Other.gguf',
      url: `https://huggingface.co/${repo}/resolve/main/Other.gguf`,
      size: 0,
    })
    expect(plan.projector).toBeNull()
    expect(plan.offers_projector).toBe(false)
    expect(plan.engine?.download_size).toBe(0)
  })
})
