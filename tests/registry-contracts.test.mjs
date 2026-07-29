import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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

test('TurboQuant manifest preserves per-backend release identity', () => {
  const manifest = fixture('turboquant-manifest')
  assert.match(manifest.commit, /^[0-9a-f]{7,40}$/)
  unique(
    manifest.backends.map(({ id }) => id),
    'TurboQuant backend ids must be unique'
  )
  for (const backend of manifest.backends) {
    nonEmpty(backend.id, 'backend id')
    assert.ok(backend.tag.endsWith(manifest.commit))
    assert.ok(backend.asset.includes(backend.id))
  }
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
