import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'

const fixture = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/registries/${name}.json`, import.meta.url),
      'utf8'
    )
  )

const nonEmpty = (value, label) =>
  assert.equal(typeof value === 'string' && value.length > 0, true, label)
const unique = (values, label) =>
  assert.equal(new Set(values).size, values.length, label)

test('upstream manifest preserves the pinned release asset contract', () => {
  const manifest = fixture('upstream-manifest')
  assert.match(manifest.tag_name, /^b\d+$/)
  assert.ok(Date.parse(manifest.updated_at))
  assert.ok(manifest.assets.length > 0)
  unique(
    manifest.assets.map(({ name }) => name),
    'upstream assets must be unique'
  )
  for (const { name } of manifest.assets) {
    assert.match(name, /\.(zip|tar\.gz)$/)
  }
})

test('TurboQuant manifest ships one unified release for every backend', () => {
  const manifest = fixture('turboquant-manifest')
  assert.match(manifest.commit, /^[0-9a-f]{7,40}$/)
  unique(
    manifest.backends.map(({ id }) => id),
    'TurboQuant backend ids must be unique'
  )
  // The fork now cuts a single `b<upstream-build>-<fork-semver>` release that
  // carries every platform, replacing the per-backend `turboquant-<id>-<sha>`
  // tags. A split tag means the manifest was assembled from two releases.
  const [{ tag: unifiedTag }] = manifest.backends
  assert.match(unifiedTag, /^b\d+-\d+\.\d+\.\d+$/)
  for (const backend of manifest.backends) {
    nonEmpty(backend.id, 'backend id')
    assert.equal(backend.tag, unifiedTag)
    assert.ok(backend.asset.includes(backend.id))
    assert.match(
      backend.asset,
      backend.id.startsWith('windows-') ? /\.zip$/ : /\.tar\.gz$/
    )
  }
})

test('TurboQuant manifest covers the full Linux backend matrix', () => {
  const manifest = fixture('turboquant-manifest')
  const ids = new Set(manifest.backends.map(({ id }) => id))
  for (const id of [
    'linux-x64-cpu',
    'linux-x64-cuda-12.4',
    'linux-x64-cuda-13.3',
    'linux-x64-rocm',
    'linux-x64-vulkan',
  ]) {
    assert.ok(ids.has(id), `manifest must publish ${id}`)
  }
})

// The release index is what removed every hardcoded tag from the app: it is
// published as an asset of each fork release and read at runtime, so a new
// engine reaches users without an Atomic Chat release. The app must be able to
// tell stable releases from prereleases and to refuse a build that needs a
// newer app, all from this document alone.
test('TurboQuant release index describes stable releases the app can install', () => {
  const index = fixture('turboquant-index')
  assert.equal(index.schema_version, 1)
  assert.ok(Date.parse(index.generated_at))
  unique(
    index.releases.map(({ tag }) => tag),
    'release tags must be unique'
  )

  const stable = index.releases.filter((release) => release.prerelease !== true)
  assert.ok(stable.length > 0, 'index must carry at least one stable release')
  assert.equal(index.latest, stable[0].tag)
  assert.match(index.latest, /^b\d+-\d+\.\d+\.\d+$/)

  for (const release of index.releases) {
    nonEmpty(release.tag, 'release tag')
    assert.equal(typeof release.prerelease, 'boolean')
    // Only the unified scheme is installable; dev-latest and the legacy
    // per-variant tags must be marked as prereleases so the app skips them.
    if (release.prerelease !== true) {
      assert.match(release.tag, /^b\d+-\d+\.\d+\.\d+$/)
    }
    if (release.min_app_version !== undefined) {
      assert.match(release.min_app_version, /^\d+\.\d+\.\d+$/)
    }
    assert.ok(release.variants.length > 0)
    unique(
      release.variants.map(({ id }) => id),
      `${release.tag} variant ids must be unique`
    )
    for (const variant of release.variants) {
      nonEmpty(variant.id, 'variant id')
      nonEmpty(variant.asset, 'variant asset')
      assert.ok(variant.asset.includes(variant.id))
      assert.match(
        variant.asset,
        variant.id.startsWith('windows-') ? /\.zip$/ : /\.tar\.gz$/
      )
      if (variant.sha256 !== undefined) {
        assert.match(variant.sha256, /^[0-9a-f]{64}$/)
      }
    }
  }
})

test('release index and legacy manifest agree on the newest stable release', () => {
  const index = fixture('turboquant-index')
  const manifest = fixture('turboquant-manifest')
  const latest = index.releases.find(({ tag }) => tag === index.latest)
  const indexIds = new Set(latest.variants.map(({ id }) => id))
  // The conf manifest stays the last-resort fallback, so it must not offer a
  // narrower matrix than the index it is standing in for.
  for (const { id, tag } of manifest.backends) {
    assert.equal(tag, index.latest)
    assert.ok(indexIds.has(id), `release index must publish ${id}`)
  }
})

// The whole point of the release index is that no tag lives in the app. A
// literal that creeps back in silently re-pins users to one engine build.
test('the TurboQuant provider hardcodes no release tag', () => {
  const root = new URL('../extensions/llamacpp-extension/src/', import.meta.url)
  const offenders = []

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir)
      if (entry.isDirectory()) {
        if (entry.name !== 'test') walk(child)
        continue
      }
      if (!entry.name.endsWith('.ts')) continue

      const source = readFileSync(child, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => {
          const trimmed = line.trimStart()
          return !trimmed.startsWith('//') && !trimmed.startsWith('*')
        })
        .join('\n')

      if (/b\d+-\d+\.\d+\.\d+/.test(source)) {
        offenders.push(entry.name)
      }
    }
  }

  walk(root)
  assert.deepEqual(
    offenders,
    [],
    `release tags must be resolved at runtime, not written into ${offenders.join(', ')}`
  )
})

test('recommended models conform to the loader schema contract', () => {
  const manifest = fixture('recommended-models')
  assert.equal(manifest.schema_version, 1)
  unique(
    manifest.recommendations.map(({ model_name }) => model_name),
    'recommendations must be unique'
  )
  for (const recommendation of manifest.recommendations) {
    assert.match(recommendation.model_name, /^[^/]+\/[^/]+$/)
    assert.match(recommendation.description_key, /^hub:/)
  }
})

test('provider registry contains safe provider and model contracts', () => {
  const manifest = fixture('provider-registry')
  assert.equal(manifest.schema_version, 1)
  unique(
    manifest.providers.map(({ provider }) => provider),
    'provider ids must be unique'
  )
  for (const provider of manifest.providers) {
    nonEmpty(provider.provider, 'provider id')
    assert.equal(provider.api_key, '')
    assert.doesNotThrow(() => new URL(provider.base_url))
    unique(
      provider.models.map(({ id }) => id),
      `${provider.provider} model ids must be unique`
    )
    for (const model of provider.models) {
      nonEmpty(model.name, 'model name')
      assert.ok(model.capabilities.includes('completion'))
    }
  }
})

test('catalog and index remain mutually consistent', () => {
  const catalog = fixture('catalog')
  const index = fixture('catalog-index')
  assert.equal(catalog.manifest_version, 1)
  assert.equal(catalog.schema_version, 1)
  assert.equal(index.index_version, 1)
  assert.equal(index.catalog_updated_at, catalog.updated_at)
  assert.equal(index.catalog_total_models, catalog.models.length)
  assert.equal(catalog.stats.total_models, catalog.models.length)
  unique(
    catalog.models.map(({ model_name }) => model_name),
    'catalog model ids must be unique'
  )
  for (const model of catalog.models) {
    assert.match(model.model_name, /^[^/]+\/[^/]+$/)
    assert.ok(Number.isInteger(model.downloads) && model.downloads >= 0)
    assert.equal(model.num_quants, model.quants.length)
    for (const quant of model.quants) {
      assert.match(
        quant.path,
        /^https:\/\/huggingface\.co\/.+\/resolve\/main\/.+$/
      )
    }
  }
  assert.equal(index.minisearch.serializationVersion, 2)
})

test('fixture provenance is pinned to immutable revisions', () => {
  const sources = fixture('sources')
  for (const source of Object.values(sources)) {
    assert.match(source.revision, /^[0-9a-f]{40}$/)
  }
})
