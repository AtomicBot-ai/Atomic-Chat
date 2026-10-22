/**
 * LiteRT-LM models as Model Hub entries (change `add-litert-lm-runtime`, spec `litert-lm-desktop`,
 * "Model Hub предлагает модели LiteRT-LM"): a curated model of conf's list or a repository of its
 * Hugging Face organisations, shaped as the Hub's `CatalogModel` with its variants under
 * `litert_lm`.
 *
 * `model_name` is `litert-lm/<model id>` (a Hugging Face model's id is its repository): the Hub
 * keys rows and its `?model=` link by it, and the prefix keeps it apart from a GGUF repository.
 */

import type { LiteRtLmModel, LiteRtLmPlatform } from '@/services/litert-lm/curated'
import type { LiteRtLmHfModel } from '@/services/litert-lm/huggingface'
import type { LiteRtLmHubModel } from '@/services/litert-lm/types'
import type { CatalogModel } from '@/services/models/types'

export const LITERT_LM_HUB_PREFIX = 'litert-lm/'

/** A LiteRT-LM entry's own fields, or `undefined` for any other Hub entry. */
export function liteRtLmOf(model: CatalogModel | null | undefined): LiteRtLmHubModel | undefined {
  return model?.is_litert_lm ? model.litert_lm : undefined
}

function card(fields: LiteRtLmHubModel): CatalogModel {
  return {
    model_name: `${LITERT_LM_HUB_PREFIX}${fields.model_id}`,
    description: fields.summary,
    downloads: 0,
    ...(fields.tools !== undefined ? { tools: fields.tools } : {}),
    is_litert_lm: true,
    litert_lm: fields,
  }
}

/** A model of conf's curated list: what it can do is known before download. */
export function curatedLiteRtLmCard(model: LiteRtLmModel): CatalogModel {
  return card({
    origin: 'curated',
    model_id: model.id,
    name: model.name,
    summary: model.description,
    license: model.license,
    repo: model.repo,
    revision: model.revision,
    gated: model.gated,
    context_length: model.context_length,
    tools: model.tools,
    reasoning: model.reasoning,
    vision: model.vision,
    variants: model.variants.map((variant) => ({
      id: variant.id,
      backend: variant.backend,
      ...(variant.npu ? { npu: variant.npu } : {}),
      platforms: variant.platforms,
      ...(variant.min_runtime_version ? { min_runtime_version: variant.min_runtime_version } : {}),
      file: variant.file,
    })),
  })
}

/** A Hugging Face repository: what it can do is read from the file after download. */
export function hfLiteRtLmCard(model: LiteRtLmHfModel): CatalogModel {
  return card({
    origin: 'huggingface',
    model_id: model.repo,
    name: model.name,
    summary: model.repo,
    license: model.license,
    repo: model.repo,
    revision: model.revision,
    gated: model.gated,
    variants: model.variants.map((variant) => ({
      id: variant.id,
      backend: variant.backend,
      ...(variant.npu ? { npu: variant.npu } : {}),
      platforms: variant.platforms,
      file: variant.file,
    })),
  })
}

/** Whether `query` names the entry: every word in its id, name or summary, case aside. */
export function liteRtLmMatches(model: CatalogModel, query: string): boolean {
  const fields = liteRtLmOf(model)
  if (!fields) return false
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const text = `${fields.model_id} ${fields.name} ${fields.summary}`.toLowerCase()
  return words.every((word) => text.includes(word))
}

/** This machine as conf's lists name platforms; the build's own target, so no probe is needed. */
export function hostLiteRtLmPlatform(): LiteRtLmPlatform {
  if (IS_MACOS) return 'macos-arm64'
  if (IS_WINDOWS) return 'win-x64'
  return IS_ARM64 ? 'linux-arm64' : 'linux-x64'
}

/** How a variant is named: its backend, and the NPU generation for an NPU file (as `atc` names it). */
export function liteRtLmVariantLabel(variant: { backend: string; npu?: string }): string {
  return variant.npu ? `${variant.backend.toUpperCase()} ${variant.npu}` : variant.backend.toUpperCase()
}
