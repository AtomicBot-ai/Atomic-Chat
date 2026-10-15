/**
 * Foundry Local models as Model Hub entries (change `add-foundry-local`, spec "Model Hub предлагает
 * модели Foundry Local"): a curated model of conf's list or a chat model of Microsoft's catalog,
 * shaped as the Hub's `CatalogModel` with its variants under `foundry_local`.
 *
 * `model_name` is `foundry-local/<model id>`: the Hub keys rows and its `?model=` link by it, and
 * the prefix keeps it apart from any Hugging Face repository.
 */

import type { FoundryLocalModel } from '@/services/foundry-local/curated'
import type { CatalogModel as MicrosoftModel } from '@/services/foundry-local/microsoft-catalog'
import type {
  FoundryLocalHubModel,
  FoundryLocalHubVariant,
} from '@/services/foundry-local/types'
import type { CatalogModel } from '@/services/models/types'

export const FOUNDRY_LOCAL_HUB_PREFIX = 'foundry-local/'

/** A Foundry Local entry's own fields, or `undefined` for any other Hub entry. */
export function foundryLocalOf(model: CatalogModel | null | undefined): FoundryLocalHubModel | undefined {
  return model?.is_foundry_local ? model.foundry_local : undefined
}

function card(fields: FoundryLocalHubModel): CatalogModel {
  return {
    model_name: `${FOUNDRY_LOCAL_HUB_PREFIX}${fields.model_id}`,
    description: fields.summary,
    downloads: 0,
    ...(fields.tools !== undefined ? { tools: fields.tools } : {}),
    is_foundry_local: true,
    foundry_local: fields,
  }
}

/** A model of conf's curated list: its variants with their files, sizes and sha256. */
export function curatedHubCard(model: FoundryLocalModel): CatalogModel {
  return card({
    origin: 'curated',
    model_id: model.id,
    name: model.name,
    summary: model.description,
    license: model.license,
    context_length: model.context_length,
    tools: model.tools,
    reasoning: model.reasoning,
    variants: model.variants.map((variant) => ({
      id: variant.id,
      device: variant.device,
      execution_provider: variant.execution_provider,
      platforms: variant.platforms,
      asset_id: variant.source.asset_id,
      version: variant.source.version,
      size_bytes: variant.files.reduce((total, file) => total + file.size, 0),
      ...(variant.context_length ? { context_length: variant.context_length } : {}),
      files: variant.files,
      path_prefix: variant.source.path_prefix,
    })),
  })
}

/** A chat model of Microsoft's catalog: no files, no context, tool calling or reasoning yet. */
export function catalogHubCard(model: MicrosoftModel): CatalogModel {
  return card({
    origin: 'microsoft',
    model_id: model.id,
    name: model.name,
    summary: model.license ?? '',
    license: model.license,
    variants: model.variants.map((variant) => ({
      id: variant.id,
      device: variant.device,
      execution_provider: variant.execution_provider,
      platforms: variant.platforms,
      asset_id: variant.asset_id,
      version: variant.version,
      size_bytes: variant.size_bytes,
    })),
  })
}

/** Whether `query` names the entry: every word in its id, name or summary, case aside. */
export function foundryLocalMatches(model: CatalogModel, query: string): boolean {
  const fields = foundryLocalOf(model)
  if (!fields) return false
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const text = `${fields.model_id} ${fields.name} ${fields.summary}`.toLowerCase()
  return words.every((word) => text.includes(word))
}

const ACCELERATOR_LABELS: Record<FoundryLocalHubVariant['execution_provider'], string> = {
  cpu: 'CPU',
  cuda: 'CUDA',
  webgpu: 'WebGPU',
  openvino: 'OpenVINO',
  qnn: 'QNN',
  vitisai: 'Vitis AI',
}

/** How a variant is named: its accelerator, and the device where the accelerator has more than one. */
export function variantLabel(variant: Pick<FoundryLocalHubVariant, 'execution_provider' | 'device'>): string {
  const accelerator = ACCELERATOR_LABELS[variant.execution_provider]
  const showDevice = variant.device === 'npu' || (variant.execution_provider === 'openvino' && variant.device === 'gpu')
  return showDevice ? `${accelerator} ${variant.device.toUpperCase()}` : accelerator
}

/** This machine as conf's lists name platforms; the build's own target, so no probe is needed. */
export function hostFoundryLocalPlatform(): string {
  if (IS_MACOS) return 'macos-arm64'
  if (IS_WINDOWS) return IS_ARM64 ? 'win-arm64' : 'win-x64'
  return IS_ARM64 ? 'linux-arm64' : 'linux-x64'
}

const DEVICE_PREFERENCE: Record<FoundryLocalHubVariant['device'], number> = { npu: 0, gpu: 1, cpu: 2 }

/**
 * The variant a card opens on (spec "Вариант по умолчанию выбирается под железо"): NPU, then GPU,
 * then CPU, among those the core says run here (`ok`) or will once their accelerator is prepared;
 * in list order within a device. `undefined` when none qualifies, or before any verdict is in.
 */
export function pickDefaultVariant<V extends Pick<FoundryLocalHubVariant, 'id' | 'device'>>(
  variants: readonly V[],
  verdictOf: (variant: V) => string | undefined
): V | undefined {
  const usable = variants.filter((variant) => {
    const verdict = verdictOf(variant)
    return verdict === 'ok' || verdict === 'accelerator-not-prepared'
  })
  return [...usable].sort((a, b) => DEVICE_PREFERENCE[a.device] - DEVICE_PREFERENCE[b.device])[0]
}
