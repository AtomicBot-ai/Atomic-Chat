/**
 * "What do I reply with?" — the answer, derived from the provider list.
 *
 * The composer used to answer this with a red line ("Select a model to start
 * chatting") that named the problem and offered no way out of it. This module
 * is the data half of the widget that replaced it: it turns the provider store
 * into the set of things the user could actually send a message with right
 * now, and classifies that set into the one of three shapes the widget renders.
 *
 * Pure on purpose — every branch of the widget is decided here, so the
 * component only has to render, and the branch logic can be tested without a
 * DOM, a service hub or a hardware probe.
 */

import { isAnswerableModel } from '@/lib/answerable-model'
import { isProviderConnected } from '@/lib/cloud-providers'
import { prettyModelName } from '@/lib/model-display-name'
import { getProviderTitle } from '@/lib/utils'
import { isLocalProvider } from '@/utils/registerRemoteProvider'

/** Where the option runs. Decides how it is started, and how it is labelled. */
export type ReplyModelKind = 'local' | 'cloud'

/** One thing the user can answer with, as the widget renders it. */
export type ReplyModelOption = {
  /** Stable list key. Provider-qualified: two llama.cpp providers list the
   *  same GGUF from the shared models dir, so the model id alone collides. */
  key: string
  kind: ReplyModelKind
  providerName: string
  modelId: string
  /** Primary line. */
  label: string
  /** Secondary line, or `undefined` when it would only repeat the label. */
  sublabel?: string
}

/**
 * Which of the three shapes the widget takes.
 *
 *  - `auto_start` — exactly one thing to answer with. Start it and say so;
 *    asking a question with one possible answer is not a question.
 *  - `pick` — several. Offer them, last used first.
 *  - `none` — nothing on this device. Recommend a download.
 *
 * Cloud alternatives are offered in all three, so they are not part of this.
 */
export type ReplyGateBranch = 'auto_start' | 'pick' | 'none'

/** The last-used pointer as `localStorage` stores it. */
export type LastUsedModel = { provider: string; model: string } | null

const optionKey = (providerName: string, modelId: string) =>
  `${providerName}:${modelId}`

/**
 * The quantization token in a model id, or `undefined` when there is none.
 *
 * Unlike `quantLabel` in `model-card.ts` this never falls back to "the last
 * segment": a row for `my-model` must not be captioned "MY-MODEL".
 */
function detectQuant(modelId: string): string | undefined {
  const seg = modelId.split('/').pop() ?? modelId
  const bare = seg.replace(/\.gguf$/i, '')
  const mlx = bare.match(/(\d+)\s*bit$/i)
  if (mlx) return `${mlx[1]}-bit`
  const gguf = bare.match(/[-_.]((?:[IT]?Q\d[0-9A-Za-z_]*)|BF16|F16|F32)$/i)
  return gguf ? gguf[1].toUpperCase() : undefined
}

/**
 * Models on disk that can actually be loaded.
 *
 * Same three exclusions the startup auto-start applies (`getModelToStart`): a
 * deactivated provider must not be resurrected, a broken-link model only
 * crashes the engine, and the embedding model is not something to chat with.
 * The model-level half of that is {@link isAnswerableModel}, shared with the
 * onboarding gate.
 */
function localOptions(providers: ModelProvider[]): ReplyModelOption[] {
  const options: ReplyModelOption[] = []
  for (const provider of providers) {
    if (!isLocalProvider(provider.provider)) continue
    if (provider.active === false) continue
    for (const model of provider.models ?? []) {
      if (!isAnswerableModel(model)) continue
      // The quant is the one fact that separates two builds of the same
      // model on a pick list, and it is the only size signal the provider
      // store carries — a file size would need a stat per row.
      const quant = detectQuant(model.id)
      const engine = getProviderTitle(provider.provider)
      options.push({
        key: optionKey(provider.provider, model.id),
        kind: 'local',
        providerName: provider.provider,
        modelId: model.id,
        label: prettyModelName(model.id),
        sublabel: quant ? `${engine} · ${quant}` : engine,
      })
    }
  }
  return options
}

/**
 * One row per connected cloud provider — not one per model.
 *
 * A connected OpenRouter lists hundreds of models; enumerating them would bury
 * the two local models the user actually has and turn a decision into a search.
 * The row therefore stands for the provider and carries its last-used model,
 * falling back to the first one it ships. Picking a *different* cloud model is
 * what the model dropdown is for, and it is one click away once the composer
 * is unblocked.
 */
function cloudOptions(
  providers: ModelProvider[],
  lastUsed: LastUsedModel
): ReplyModelOption[] {
  const options: ReplyModelOption[] = []
  for (const provider of providers) {
    if (isLocalProvider(provider.provider)) continue
    if (provider.active === false) continue
    if (!isProviderConnected(provider)) continue

    const models = provider.models ?? []
    const preferred =
      (lastUsed?.provider === provider.provider &&
        models.find((model) => model.id === lastUsed.model)) ||
      models[0]
    if (!preferred) continue

    options.push({
      key: optionKey(provider.provider, preferred.id),
      kind: 'cloud',
      providerName: provider.provider,
      modelId: preferred.id,
      label: getProviderTitle(provider.provider),
      sublabel: preferred.id,
    })
  }
  return options
}

/**
 * Everything the user could answer with right now, last used first.
 *
 * Local before cloud otherwise: a local model is already on the disk the user
 * paid for, and it is the thing this app is for.
 */
export function collectReplyModels(
  providers: ModelProvider[],
  lastUsed: LastUsedModel = null
): ReplyModelOption[] {
  const options = [
    ...localOptions(providers),
    ...cloudOptions(providers, lastUsed),
  ]

  if (!lastUsed) return options
  const lastKey = optionKey(lastUsed.provider, lastUsed.model)
  const index = options.findIndex((option) => option.key === lastKey)
  if (index <= 0) return options
  return [options[index], ...options.filter((_, i) => i !== index)]
}

/** {@link ReplyGateBranch} for a given option set. */
export function replyGateBranch(
  options: readonly ReplyModelOption[]
): ReplyGateBranch {
  if (options.length === 0) return 'none'
  if (options.length === 1) return 'auto_start'
  return 'pick'
}

/**
 * Telemetry context for the widget's impression: how much of each kind was
 * found, and whether a cloud connection already exists.
 *
 * Counted over the raw provider list rather than over {@link collectReplyModels}
 * so the cloud figure is "providers the user connected", not "rows we chose to
 * render" — the latter is a presentation decision that could change.
 */
export function replyGateContext(providers: ModelProvider[]): {
  localModelCount: number
  cloudProviderCount: number
  hasCloudConnection: boolean
} {
  const localModelCount = localOptions(providers).length
  const cloudProviderCount = providers.filter(
    (provider) =>
      !isLocalProvider(provider.provider) &&
      provider.active !== false &&
      isProviderConnected(provider)
  ).length
  return {
    localModelCount,
    cloudProviderCount,
    hasCloudConnection: cloudProviderCount > 0,
  }
}
