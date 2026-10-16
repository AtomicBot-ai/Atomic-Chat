#!/usr/bin/env node
/**
 * Refresh one of Radium's bundled registry snapshots from a source you name.
 *
 * Radium ships its registries inside the app (see `src/lib/registry-source.ts`)
 * and never fetches them by default. This script is the one, deliberate way to
 * update a snapshot: a maintainer runs it by hand, reviews the diff, and
 * commits it. It is not part of `dev` or `build`, and it has no default
 * source — nothing is pulled unless you pass a URL or a path.
 *
 *   node scripts/snapshot-registries.mjs <registry> <source>
 *
 *   registry  providers | recommended-models | staff-picks | media | model-catalog
 *   source    URL or local path of the manifest. For `model-catalog`, the base
 *             URL or directory that holds `catalog.json.gz` and
 *             `catalog.idx.json.gz`.
 *
 * Every snapshot is reviewed on the way in:
 *
 *   - Entries hosted by an org on UPSTREAM_OWNED_ORGS are rewritten to the
 *     neutral repository in NEUTRAL_REPLACEMENTS when one is listed, and
 *     dropped otherwise (the model catalog is a mirror of Hugging Face, so a
 *     dropped entry is simply absent there).
 *   - After that, any remaining reference to an upstream-owned host, repo or
 *     org fails the run instead of writing the file. Fix the source or extend
 *     NEUTRAL_REPLACEMENTS — after verifying the replacement on Hugging Face —
 *     and run again.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync, gunzipSync } from 'node:zlib'
import MiniSearch from 'minisearch'

const WEB_APP = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Hugging Face orgs whose repositories Radium does not depend on. */
export const UPSTREAM_OWNED_ORGS = ['AtomicChat']

/**
 * Anything matching this in a written snapshot is a failure. Mirrors the
 * patterns in `tests/no-atomic-sources.test.mjs`, which re-checks the output.
 */
export const UPSTREAM_REFERENCE =
  /AtomicBot-ai|atomic-chat-conf|atomic-chat-model-catalog|atomicagent\.io|huggingface\.co\/AtomicChat\/|"AtomicChat\//

/**
 * Reviewed neutral equivalents for upstream-hosted repositories, verified on
 * Hugging Face on 2026-10-16 (repo exists, carries the format and quant the
 * entry pins). GGUF goes to the model's own org or a well-known quantizer;
 * MLX to mlx-community / lmstudio-community.
 */
export const NEUTRAL_REPLACEMENTS = {
  'AtomicChat/Qwen3.5-4B-GGUF': 'unsloth/Qwen3.5-4B-GGUF',
  'AtomicChat/Qwen3.5-9B-GGUF': 'unsloth/Qwen3.5-9B-GGUF',
  'AtomicChat/Qwen3.5-9B-MLX-4bit': 'mlx-community/Qwen3.5-9B-MLX-4bit',
  'AtomicChat/Qwen3.6-27B-GGUF': 'unsloth/Qwen3.6-27B-GGUF',
  'AtomicChat/Qwen3.6-27B-MLX-4bit': 'mlx-community/Qwen3.6-27B-4bit',
  'AtomicChat/Qwen3.6-35B-A3B-GGUF': 'unsloth/Qwen3.6-35B-A3B-GGUF',
  'AtomicChat/Qwen3.8-27B-GGUF': 'unsloth/Qwen3.8-27B-GGUF',
  'AtomicChat/gemma-4-E2B-it-GGUF': 'unsloth/gemma-4-E2B-it-GGUF',
  'AtomicChat/gemma-4-E2B-it-MLX-4bit':
    'lmstudio-community/gemma-4-E2B-it-MLX-4bit',
  'AtomicChat/gemma-4-E4B-it-GGUF': 'unsloth/gemma-4-E4B-it-GGUF',
  'AtomicChat/gemma-4-E4B-it-MLX-4bit':
    'lmstudio-community/gemma-4-E4B-it-MLX-4bit',
  'AtomicChat/gemma-4-12B-it-GGUF': 'unsloth/gemma-4-12b-it-GGUF',
  'AtomicChat/gemma-4-12B-it-MLX-4bit':
    'lmstudio-community/gemma-4-12B-it-MLX-4bit',
  'AtomicChat/gemma-4-26B-A4B-it-GGUF': 'unsloth/gemma-4-26B-A4B-it-GGUF',
  'AtomicChat/gemma-4-26B-A4B-it-MLX-4bit':
    'lmstudio-community/gemma-4-26B-A4B-it-MLX-4bit',
  'AtomicChat/gemma-4-31B-it-GGUF': 'unsloth/gemma-4-31B-it-GGUF',
  'AtomicChat/gemma-4-31B-it-MLX-4bit':
    'lmstudio-community/gemma-4-31B-it-MLX-4bit',
  'AtomicChat/Muse-Glimmer-30B-GGUF': 'meta-models/Muse-Glimmer-30B-GGUF',
  'AtomicChat/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-GGUF':
    'unsloth/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-GGUF',
  'AtomicChat/Ling-3.0-flash-GGUF': 'inclusionAI/Ling-3.0-flash-GGUF',
  'AtomicChat/Ornith-1.5-9B-GGUF': 'ornith-ai/Ornith-1.5-9B-GGUF',
  'AtomicChat/Ornith-1.5-35B-A3B-GGUF': 'ornith-ai/Ornith-1.5-35B-A3B-GGUF',
  'AtomicChat/Laguna-S-2.1-GGUF': 'poolside/Laguna-S-2.1-GGUF',
  'AtomicChat/Laguna-S-2.1-MLX-4bit': 'TensorFold/Laguna-S-2.1-MLX-4bit',
}

const isUpstreamOwned = (repo) =>
  typeof repo === 'string' &&
  UPSTREAM_OWNED_ORGS.some((org) => repo.startsWith(`${org}/`))

/** Rewrite one repo id, or return null when it must be dropped. */
const neutralRepo = (repo) => {
  if (!isUpstreamOwned(repo)) return repo
  return NEUTRAL_REPLACEMENTS[repo] ?? null
}

const readSource = async (source) => {
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source)
    if (!response.ok) {
      throw new Error(
        `${source}: HTTP ${response.status} ${response.statusText}`
      )
    }
    return Buffer.from(await response.arrayBuffer())
  }
  return readFileSync(source)
}

const readJson = async (source) => {
  const buf = await readSource(source)
  const text = source.endsWith('.gz')
    ? gunzipSync(buf).toString('utf8')
    : buf.toString('utf8')
  return JSON.parse(text)
}

const writeAtomic = (path, data) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, data)
  renameSync(`${path}.tmp`, path)
}

const assertClean = (label, text) => {
  const hit = text.match(UPSTREAM_REFERENCE)
  if (hit) {
    throw new Error(
      `${label}: still references "${hit[0]}" after review. Add a verified ` +
        'neutral replacement to NEUTRAL_REPLACEMENTS or fix the source.'
    )
  }
}

const writeJsonSnapshot = (name, manifest) => {
  const text = `${JSON.stringify(manifest, null, 2)}\n`
  assertClean(name, text)
  const out = join(WEB_APP, 'src', 'registries', `${name}.json`)
  writeAtomic(out, text)
  console.log(`[snapshot] ${name}: wrote ${out}`)
}

/** Drop the `$schema` pointer: it names a file in the source repository. */
const withoutSchemaPointer = ({ $schema: _ignored, ...rest }) => rest

/** Rewrite (or drop) every recommendation in a list, de-duplicating by repo. */
const reviewRecommendations = (list, dropped) => {
  const seen = new Set()
  const out = []
  for (const entry of list ?? []) {
    const repo = neutralRepo(entry.model_name)
    if (!repo) {
      dropped.push(entry.model_name)
      continue
    }
    if (seen.has(repo)) continue
    seen.add(repo)
    out.push({ ...entry, model_name: repo })
  }
  return out
}

const SNAPSHOTS = {
  async 'providers'(source) {
    writeJsonSnapshot('providers', withoutSchemaPointer(await readJson(source)))
  },

  async 'media'(source) {
    writeJsonSnapshot('media', withoutSchemaPointer(await readJson(source)))
  },

  async 'recommended-models'(source) {
    const manifest = withoutSchemaPointer(await readJson(source))
    const dropped = []
    const reviewed = {
      ...manifest,
      recommendations: reviewRecommendations(manifest.recommendations, dropped),
    }
    if (manifest.low_spec_recommendations) {
      reviewed.low_spec_recommendations = reviewRecommendations(
        manifest.low_spec_recommendations,
        dropped
      )
    }
    if (manifest.tiers) {
      reviewed.tiers = Object.fromEntries(
        Object.entries(manifest.tiers).map(([tier, list]) => [
          tier,
          reviewRecommendations(list, dropped),
        ])
      )
    }
    if (dropped.length) console.warn('[snapshot] dropped:', dropped)
    writeJsonSnapshot('recommended-models', reviewed)
  },

  async 'staff-picks'(source) {
    const manifest = withoutSchemaPointer(await readJson(source))
    const dropped = []
    const seen = new Set()
    const picks = []
    for (const pick of manifest.picks ?? []) {
      const repo = neutralRepo(pick.model_name)
      if (!repo) {
        dropped.push(pick.model_name)
        continue
      }
      if (seen.has(repo)) continue
      seen.add(repo)
      picks.push({ ...pick, model_name: repo })
    }
    if (dropped.length) console.warn('[snapshot] dropped:', dropped)
    writeJsonSnapshot('staff-picks', { ...manifest, picks })
  },

  async 'model-catalog'(source) {
    const base = source.replace(/\/+$/, '')
    const catalog = await readJson(`${base}/catalog.json.gz`)
    const index = await readJson(`${base}/catalog.idx.json.gz`)

    // The catalog mirrors Hugging Face org listings. An upstream-owned org's
    // models are re-uploads of models the other orgs already carry, so they
    // are dropped rather than rewritten.
    const keep = (model) =>
      !isUpstreamOwned(model.model_name) &&
      !UPSTREAM_REFERENCE.test(JSON.stringify(model))
    const dropped = catalog.models
      .filter((m) => !keep(m))
      .map((m) => m.model_name)
    const models = catalog.models.filter(keep)

    const stats = catalog.stats ? structuredClone(catalog.stats) : undefined
    for (const org of UPSTREAM_OWNED_ORGS) {
      if (stats?.by_org) delete stats.by_org[org]
      if (stats?.by_org_skipped) delete stats.by_org_skipped[org]
    }
    if (stats) stats.total_models = models.length

    const reviewedCatalog = {
      ...withoutSchemaPointer(catalog),
      ...(catalog.orgs
        ? {
            orgs: catalog.orgs.filter(
              (org) => !UPSTREAM_OWNED_ORGS.includes(org)
            ),
          }
        : {}),
      ...(stats ? { stats } : {}),
      models,
    }

    // Remove the same documents from the pre-built search index. Options are
    // read back from the serialized index so this works for whatever field
    // set the index was built with.
    const raw =
      typeof index.minisearch === 'string'
        ? JSON.parse(index.minisearch)
        : index.minisearch
    const firstStored = Object.values(raw.storedFields ?? {})[0] ?? {}
    const search = MiniSearch.loadJS(raw, {
      idField: 'id',
      fields: Object.keys(raw.fieldIds),
      storeFields: Object.keys(firstStored),
    })
    const droppedIds = new Set(dropped)
    for (const id of Object.values(raw.documentIds)) {
      if (droppedIds.has(id)) search.discard(id)
    }
    await search.vacuum()
    const reviewedIndex = {
      ...index,
      catalog_total_models: models.length,
      minisearch: search.toJSON(),
    }

    const catalogText = JSON.stringify(reviewedCatalog)
    const indexText = JSON.stringify(reviewedIndex)
    assertClean('model-catalog', catalogText)
    assertClean('model-catalog index', indexText)

    const publicDir = join(WEB_APP, 'public')
    writeAtomic(
      join(publicDir, 'seed-catalog.json.gz'),
      gzipSync(catalogText, { level: 9 })
    )
    writeAtomic(
      join(publicDir, 'seed-catalog.idx.json.gz'),
      gzipSync(indexText, { level: 9 })
    )
    console.log(
      `[snapshot] model-catalog: kept ${models.length} models, dropped ${dropped.length} ` +
        `upstream-owned entries (${search.documentCount} indexed)`
    )
  },
}

const [name, source] = process.argv.slice(2)
if (!name || !source || !SNAPSHOTS[name]) {
  console.error(
    'usage: node scripts/snapshot-registries.mjs ' +
      `<${Object.keys(SNAPSHOTS).join('|')}> <url-or-path>`
  )
  process.exit(2)
}
await SNAPSHOTS[name](source)
