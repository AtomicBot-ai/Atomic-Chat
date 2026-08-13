import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

const repositoryRoot = process.cwd().endsWith('/web-app')
  ? resolve(process.cwd(), '..')
  : process.cwd()

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      resolve(
        repositoryRoot,
        'tests',
        'fixtures',
        'registries',
        `${name}.json`
      ),
      'utf8'
    )
  )

const nonEmptyString = z.string().min(1)
const immutableRevision = z.string().regex(/^[0-9a-f]{40}$/)

const upstreamManifestSchema = z.object({
  tag_name: z.string().regex(/^b\d+$/),
  updated_at: z.iso.datetime(),
  /// Points at our signed mirror. Absent for a tag we have not mirrored, which
  /// is what makes the app fall back to the ggml-org CDN.
  download_base: z.url().startsWith('https://').optional(),
  assets: z
    .array(
      z.object({
        name: z.string().regex(/\.(zip|tar\.gz)$/),
        sha256: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional(),
        size: z.number().int().positive().optional(),
      })
    )
    .min(1),
})

const turboquantManifestSchema = z.object({
  commit: z.string().regex(/^[0-9a-f]{7,40}$/),
  backends: z
    .array(
      z.object({
        id: nonEmptyString,
        tag: nonEmptyString,
        asset: nonEmptyString,
      })
    )
    .min(1),
})

const recommendationSchema = z.object({
  schema_version: z.literal(1),
  updated_at: z.iso.datetime(),
  recommendations: z.array(
    z.object({
      model_name: z.string().regex(/^[^/]+\/[^/]+$/),
      description_key: z.string().startsWith('hub:'),
    })
  ),
})

/**
 * Deliberately separate from `recommendationSchema`: `recommended.json` is
 * frozen for shipped clients, and staff picks must never be validated by
 * relaxing that contract.
 */
const staffPicksSchema = z.object({
  schema_version: z.literal(1),
  updated_at: z.iso.datetime(),
  picks: z
    .array(
      z.object({
        model_name: z.string().regex(/^[^/]+\/[^/]+$/),
        title: nonEmptyString.optional(),
        summary: nonEmptyString.optional(),
        description_key: z.string().startsWith('hub:').optional(),
        icon: nonEmptyString.optional(),
        format: z.enum(['gguf', 'mlx']).optional(),
        categories: z.array(nonEmptyString).optional(),
        platforms: z.array(z.enum(['macos', 'windows', 'linux'])).optional(),
        order: z.number().optional(),
        active: z.boolean().optional(),
      })
    )
    .min(1),
})

const providerRegistrySchema = z.object({
  schema_version: z.literal(1),
  updated_at: z.iso.datetime(),
  providers: z.array(
    z.object({
      provider: nonEmptyString,
      api_key: z.literal(''),
      base_url: z.url(),
      models: z.array(
        z.object({
          id: nonEmptyString,
          name: nonEmptyString,
          capabilities: z.array(z.string()).min(1),
        })
      ),
    })
  ),
})

const quantSchema = z.object({
  model_id: nonEmptyString,
  path: z.url().startsWith('https://huggingface.co/'),
  file_size: nonEmptyString,
})

const catalogSchema = z.object({
  manifest_version: z.literal(1),
  schema_version: z.literal(1),
  updated_at: z.iso.datetime(),
  stats: z.object({ total_models: z.number().int().nonnegative() }),
  models: z.array(
    z.object({
      model_name: z.string().regex(/^[^/]+\/[^/]+$/),
      downloads: z.number().int().nonnegative(),
      num_quants: z.number().int().nonnegative(),
      quants: z.array(quantSchema),
    })
  ),
})

const catalogIndexSchema = z.object({
  index_version: z.literal(1),
  catalog_updated_at: z.iso.datetime(),
  catalog_total_models: z.number().int().nonnegative(),
  minisearch: z.object({ serializationVersion: z.literal(2) }),
})

/** The only release tag shape the TurboQuant provider will install. */
const stableReleaseTag = z.string().regex(/^b\d+-\d+\.\d+\.\d+$/)

const releaseIndexSchema = z.object({
  schema_version: z.literal(1),
  latest: stableReleaseTag,
  releases: z
    .array(
      z.object({
        tag: nonEmptyString,
        prerelease: z.boolean().optional(),
        min_app_version: z
          .string()
          .regex(/^\d+\.\d+\.\d+$/)
          .optional(),
        variants: z
          .array(
            z.object({
              id: nonEmptyString,
              asset: nonEmptyString.optional(),
              size: z.number().int().positive().optional(),
              sha256: z
                .string()
                .regex(/^[0-9a-f]{64}$/)
                .optional(),
            })
          )
          .min(1),
      })
    )
    .min(1),
})

const FORK_RELEASES =
  'https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases'
const RELEASE_INDEX_URL = `${FORK_RELEASES}/latest/download/index.json`
const LATEST_RELEASE_URL = `${FORK_RELEASES}/latest`
const LEGACY_MANIFEST_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/backends/turboquant-manifest.json'

const liveContracts = [
  [
    'upstream manifest',
    'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/backends/manifest.json',
    upstreamManifestSchema,
  ],
  [
    'TurboQuant manifest',
    'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/backends/turboquant-manifest.json',
    turboquantManifestSchema,
  ],
  [
    'recommended models',
    'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/models/recommended.json',
    recommendationSchema,
  ],
  [
    'staff picks',
    'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/models/staff-picks.json',
    staffPicksSchema,
  ],
  [
    'provider registry',
    'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/providers/registry.json',
    providerRegistrySchema,
  ],
  [
    'model catalog',
    'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-model-catalog/main/dist/catalog.json.gz',
    catalogSchema,
    'gzip',
  ],
  [
    'model catalog index',
    'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-model-catalog/main/dist/catalog.idx.json.gz',
    catalogIndexSchema,
    'gzip',
  ],
] as const

describe('pinned external registry contracts', () => {
  it.each([
    ['upstream manifest', 'upstream-manifest', upstreamManifestSchema],
    ['TurboQuant manifest', 'turboquant-manifest', turboquantManifestSchema],
    ['recommended models', 'recommended-models', recommendationSchema],
    ['staff picks', 'staff-picks', staffPicksSchema],
    ['provider registry', 'provider-registry', providerRegistrySchema],
    ['model catalog', 'catalog', catalogSchema],
    ['model catalog index', 'catalog-index', catalogIndexSchema],
  ] as const)('validates the %s fixture', (_label, name, schema) => {
    expect(() => schema.parse(fixture(name))).not.toThrow()
  })

  /**
   * Shipped clients read `recommended.json` and reject a manifest whose
   * `schema_version` they do not know. Staff picks exist precisely so that the
   * Hub can evolve without touching that file, so the separation is asserted
   * rather than left to reviewer discipline.
   */
  it('keeps the onboarding manifest independent of staff picks', () => {
    const recommended = recommendationSchema.parse(fixture('recommended-models'))
    expect(recommended.schema_version).toBe(1)
    for (const entry of recommended.recommendations) {
      expect(Object.keys(entry).sort()).toEqual([
        'description_key',
        'model_name',
      ])
    }

    const setupScreen = readFileSync(
      resolve(repositoryRoot, 'web-app', 'src', 'containers', 'SetupScreen.tsx'),
      'utf8'
    )
    expect(setupScreen).toContain('useResolvedRecommendedModels')
    expect(setupScreen).not.toMatch(/staff-?picks/i)

    const recommendedLoader = readFileSync(
      resolve(
        repositoryRoot,
        'web-app',
        'src',
        'services',
        'recommended-models-registry.ts'
      ),
      'utf8'
    )
    expect(recommendedLoader).not.toMatch(/staff-?picks/i)
  })

  it('pins every fixture source to an immutable revision', () => {
    const sources = z
      .record(
        z.string(),
        z.object({
          revision: immutableRevision,
          fixtures: z.array(nonEmptyString).min(1),
        })
      )
      .parse(fixture('sources'))

    expect(Object.keys(sources).length).toBeGreaterThan(0)
  })
})

describe.runIf(process.env.ATOMIC_TEST_LIVE_REGISTRIES === '1')(
  'live external registry contracts',
  () => {
    it.each(liveContracts)(
      'validates the current %s',
      async (_label, url, schema, encoding) => {
        const response = await fetch(url)
        expect(response.ok).toBe(true)
        const payload =
          encoding === 'gzip'
            ? JSON.parse(
                gunzipSync(Buffer.from(await response.arrayBuffer())).toString(
                  'utf8'
                )
              )
            : await response.json()
        expect(() => schema.parse(payload)).not.toThrow()
      },
      30_000
    )
  }
)

/**
 * The TurboQuant engine is resolved at runtime, with no tag pinned anywhere in
 * this repository, so what the app installs tomorrow depends on the fork rather
 * than on this codebase. These run the app's own resolution rules against the
 * real endpoints: they fail when the fork changes its release shape, which is
 * exactly the day the provider would break in the field.
 */
describe.runIf(process.env.ATOMIC_TEST_LIVE_REGISTRIES === '1')(
  'live TurboQuant release resolution',
  () => {
    it(
      'resolves a stable release through the index or the latest redirect',
      async () => {
        const index = await fetch(RELEASE_INDEX_URL)

        // index.json is the target state; until the fork publishes it, the
        // /releases/latest redirect must keep naming a stable tag on its own.
        if (index.ok) {
          const payload = releaseIndexSchema.parse(await index.json())
          const stable = payload.releases.filter(
            (release) => release.prerelease !== true
          )
          expect(stable.length).toBeGreaterThan(0)
          expect(stable.map((release) => release.tag)).toContain(payload.latest)
          for (const release of stable) {
            expect(release.tag).toMatch(/^b\d+-\d+\.\d+\.\d+$/)
          }
          return
        }

        expect(index.status).toBe(404)
        const latest = await fetch(LATEST_RELEASE_URL)
        expect(latest.ok).toBe(true)
        const tag = /\/releases\/tag\/([^/?#]+)/.exec(latest.url)?.[1]
        expect(tag).toMatch(/^b\d+-\d+\.\d+\.\d+$/)
      },
      60_000
    )

    it(
      'publishes a downloadable archive for every backend the app offers',
      async () => {
        const manifest = turboquantManifestSchema.parse(
          await (await fetch(LEGACY_MANIFEST_URL)).json()
        )

        const missing: string[] = []
        for (const backend of manifest.backends) {
          const url = `${FORK_RELEASES}/download/${backend.tag}/${backend.asset}`
          // A ranged GET, because GitHub's asset CDN answers HEAD with a 403.
          // The single byte is read rather than cancelled: abandoning the body
          // poisons the pooled connection and the next request dies on it.
          const response = await fetch(url, { headers: { Range: 'bytes=0-0' } })
          await response.arrayBuffer()
          if (!response.ok) missing.push(`${backend.id} -> ${url}`)
        }

        expect(missing).toEqual([])
      },
      120_000
    )
  }
)

/**
 * The upstream provider's offline baseline is generated from the live manifest
 * (`make sync-upstream-baseline`), and the extension's own test asserts that the
 * generated module and this fixture stay byte-identical — so comparing the
 * fixture against the live manifest is comparing the shipped baseline against
 * it. A stale baseline is not a user-visible outage (the live manifest wins
 * whenever the network is up), which is why this is opt-in rather than part of
 * `verify-fast`: it is a reminder to regenerate, not a release blocker.
 */
describe.runIf(process.env.ATOMIC_TEST_LIVE_REGISTRIES === '1')(
  'live upstream baseline freshness',
  () => {
    it(
      'ships an offline baseline that still matches the live manifest',
      async () => {
        const live = upstreamManifestSchema.parse(
          await (
            await fetch(
              'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/backends/manifest.json'
            )
          ).json()
        )
        const baseline = upstreamManifestSchema.parse(
          fixture('upstream-manifest')
        )

        expect(baseline.tag_name).toBe(live.tag_name)
        expect(baseline.assets.map(({ name }) => name).sort()).toEqual(
          live.assets.map(({ name }) => name).sort()
        )
      },
      30_000
    )

    it(
      'serves every mirrored archive it advertises',
      async () => {
        const live = upstreamManifestSchema.parse(
          await (
            await fetch(
              'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/backends/manifest.json'
            )
          ).json()
        )
        // Nothing mirrored yet means nothing to check: the app is on the
        // ggml-org fallback, which the resolver contract covers.
        if (!live.download_base) return

        const missing: string[] = []
        for (const asset of live.assets) {
          if (!asset.sha256) continue
          const url = `${live.download_base}/${live.tag_name}/${asset.name}`
          // Ranged GET for the same reason as the TurboQuant check above.
          const response = await fetch(url, { headers: { Range: 'bytes=0-0' } })
          await response.arrayBuffer()
          if (!response.ok) missing.push(`${asset.name} -> ${url}`)
        }

        expect(missing).toEqual([])
      },
      120_000
    )
  }
)
