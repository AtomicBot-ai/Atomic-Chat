/**
 * GenieX models as Model Hub entries (change `add-geniex-runtime`, spec `geniex-desktop`, "Model Hub
 * предлагает модели GenieX на двух полках"): a GGUF model of conf's list or a Hugging Face
 * repository, and an AI Hub bundle model of conf's list, shaped as the Hub's `CatalogModel` with
 * their own fields under `geniex`.
 *
 * `model_name` is `geniex/<model id>`: the Hub keys rows and its `?model=` link by it, and the
 * prefix keeps it apart from a GGUF repository the llama.cpp provider lists.
 */

import type { GeniexBundleModel, GeniexGgufModel } from '@/services/geniex/curated'
import type { GeniexHfModel } from '@/services/geniex/huggingface'
import type { GeniexChip, GeniexDevice, GeniexHubModel, GeniexHubVariant } from '@/services/geniex/types'
import type { CatalogModel } from '@/services/models/types'

export const GENIEX_HUB_PREFIX = 'geniex/'

/** A GenieX entry's own fields, or `undefined` for any other Hub entry. */
export function geniexOf(model: CatalogModel | null | undefined): GeniexHubModel | undefined {
  return model?.is_geniex ? model.geniex : undefined
}

function card(fields: GeniexHubModel): CatalogModel {
  return {
    model_name: `${GENIEX_HUB_PREFIX}${fields.model_id}`,
    description: fields.summary,
    downloads: 0,
    ...(fields.tools !== undefined ? { tools: fields.tools } : {}),
    is_geniex: true,
    geniex: fields,
  }
}

/** A GGUF model of conf's curated list: what it can do is known before download. */
export function curatedGeniexCard(model: GeniexGgufModel): CatalogModel {
  return card({
    origin: 'curated',
    kind: 'gguf',
    model_id: model.id,
    name: model.name,
    summary: model.description,
    license: model.license,
    context_length: model.context_length,
    tools: model.tools,
    reasoning: model.reasoning,
    vision: model.vision,
    gguf: {
      repo: model.gguf.repo,
      revision: model.gguf.revision,
      gated: model.gguf.gated,
      file: model.gguf.file,
      ...(model.gguf.mmproj ? { mmproj: model.gguf.mmproj } : {}),
      devices: model.gguf.devices,
      platforms: model.gguf.platforms,
    },
  })
}

/** An AI Hub bundle model of conf's curated list: one variant per chip, run on the NPU. */
export function bundleGeniexCard(model: GeniexBundleModel): CatalogModel {
  return card({
    origin: 'curated',
    kind: 'qairt',
    model_id: model.id,
    name: model.name,
    summary: model.description,
    license: model.license,
    context_length: model.context_length,
    tools: model.tools,
    reasoning: model.reasoning,
    vision: model.vision,
    variants: model.variants.map((variant) => ({
      id: variant.id,
      chip: variant.chip,
      bundle: variant.bundle,
      precision: variant.precision,
      ...(variant.min_runtime_version ? { min_runtime_version: variant.min_runtime_version } : {}),
    })),
  })
}

/** A Hugging Face GGUF repository: what it can do is read from the file after download. */
export function hfGeniexCard(model: GeniexHfModel): CatalogModel {
  return card({
    origin: 'huggingface',
    kind: 'gguf',
    model_id: model.model_id,
    name: model.name,
    summary: model.repo,
    license: model.license,
    // The projector beside the file is what lets the model read images; the core's check confirms.
    ...(model.mmproj ? { vision: true } : {}),
    gguf: {
      repo: model.repo,
      revision: model.revision,
      gated: model.gated,
      file: model.file,
      ...(model.mmproj ? { mmproj: model.mmproj } : {}),
      devices: model.devices,
      platforms: model.platforms,
    },
  })
}

/** Whether `query` names the entry: every word in its id, name or summary, case aside. */
export function geniexMatches(model: CatalogModel, query: string): boolean {
  const fields = geniexOf(model)
  if (!fields) return false
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const text = `${fields.model_id} ${fields.name} ${fields.summary}`.toLowerCase()
  return words.every((word) => text.includes(word))
}

/** This machine as conf's list names platforms: the only one GenieX's SDK ships for. */
export function hostGeniexPlatform(): 'win-arm64' {
  return 'win-arm64'
}

/**
 * The GGUF repositories among the catalog search's results, in its order: the candidates the
 * Hugging Face listing reads trees for. The other formats' entries (MLX, a managed engine's
 * safetensors, the other providers' own rows) are not GGUF files GenieX can run.
 */
export function ggufCandidates(models: readonly CatalogModel[]): string[] {
  return models
    .filter(
      (model) =>
        !model.is_mlx &&
        !model.is_managed &&
        !model.is_foundry_local &&
        !model.is_litert_lm &&
        !model.is_geniex &&
        ((model.quants?.length ?? 0) > 0 ||
          model.library_name?.toLowerCase() === 'gguf' ||
          /gguf/i.test(model.model_name))
    )
    .map((model) => model.model_name)
}

/** How a device reads on a card and in a name: the NPU, the GPU, the CPU, or both. */
export function geniexDeviceLabel(device: string): string {
  return device === 'hybrid' ? 'NPU + GPU' : device.toUpperCase()
}

const DEVICE_PREFERENCE: Record<string, number> = { npu: 0, gpu: 1, cpu: 2 }

/**
 * The device a GGUF card opens on (spec geniex-models "Устройство по умолчанию выбирается под
 * железо"): NPU, then GPU, then CPU, among the model's devices the core says run here (`ok`).
 * `hybrid` is offered but never chosen by itself. `undefined` when none qualifies, or before any
 * verdict is in.
 */
export function pickDefaultGeniexDevice(
  devices: readonly GeniexDevice[],
  verdictOf: (device: GeniexDevice) => string | undefined
): GeniexDevice | undefined {
  return [...devices]
    .filter((device) => device in DEVICE_PREFERENCE && verdictOf(device) === 'ok')
    .sort((a, b) => DEVICE_PREFERENCE[a] - DEVICE_PREFERENCE[b])[0]
}

/** The bundle compiled for this computer's chip, or nothing: the card shows no other chip's. */
export function variantForChip(
  variants: readonly GeniexHubVariant[],
  chip: GeniexChip | null | undefined
): GeniexHubVariant | undefined {
  return chip ? variants.find((variant) => variant.chip === chip) : undefined
}
