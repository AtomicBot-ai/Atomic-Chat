/**
 * "What do I reply with?" — the answer, derived from the provider list.
 *
 * The composer used to answer this with a red line ("Select a model to start
 * chatting") that named the problem and offered no way out of it. This module
 * is the data half of the widget that replaced it: it turns the provider store
 * into the set of things the user could actually send a message with right
 * now, and classifies that set into the shape the widget renders.
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
 * Which of the two shapes the widget takes.
 *
 *  - `auto_start` — something to answer with. Start the model
 *    {@link resolveReplyModel} picks and say so. There is no pick list: the
 *    user already said what they want by pressing Send, and the most compact
 *    model is the one that comes up fastest.
 *  - `none` — nothing on this device. Recommend a download.
 *
 * Cloud alternatives are offered in both, so they are not part of this.
 */
export type ReplyGateBranch = 'auto_start' | 'none'

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
  return options.length === 0 ? 'none' : 'auto_start'
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

/**
 * How a send with nothing selected was answered without asking.
 *
 *  - `last_used` — the model from the previous session, local or cloud. For a
 *    cloud model this is session restore; for a local one, start on demand.
 *  - `cloud` — a connected cloud provider: costs no memory, answers at once.
 *  - `single_local` — the only model on the device.
 *  - `smallest_local` — several local models, no history: the most compact
 *    one, on a default engine when there is one. It loads fastest.
 */
export type ReplyResolution =
  | 'last_used'
  | 'cloud'
  | 'single_local'
  | 'smallest_local'

/**
 * Parameter count named in a model id, in billions, or `undefined`.
 *
 * `Qwen3.5-4B-Q4_K_M` → 4, `LFM2.5-1.2B` → 1.2, `gemma-4-E4B-it` → 4 (the
 * MatFormer "effective" prefix is dropped: it still says which of two builds
 * is lighter). Downloaded GGUFs are registered under a sanitized id that
 * spells the decimal point `_`, so `LFM2_5-2_6B` reads as 2.6, not 6. The
 * provider store carries no file size, and a stat per model on every send is
 * not worth what it would tell us; the name is the one size signal that is
 * always there.
 */
export function estimateParamsB(modelId: string): number | undefined {
  const seg = modelId.split('/').pop() ?? modelId
  const match = seg.match(/(?:^|[-_.\s])E?(\d+(?:[._]\d+)?)[bB](?=$|[-_.\s])/)
  if (!match) return undefined
  const value = Number(match[1].replace('_', '.'))
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * Bits per weight named by the quant in a model id, or `undefined`:
 * `Q4_K_M` → 4, `IQ2_XXS` → 2, `8bit` → 8, `BF16` → 16.
 */
export function estimateQuantBits(modelId: string): number | undefined {
  const bits = Number(detectQuant(modelId)?.match(/\d+/)?.[0])
  return Number.isFinite(bits) && bits > 0 ? bits : undefined
}

/**
 * The engines a model is started on when the user did not name one, in order
 * of preference: upstream llama.cpp, then MLX. A send with nothing selected
 * starts on llama.cpp whenever it holds a model; MLX is taken only when it
 * does not. Both llama.cpp providers read the shared models dir, so one GGUF
 * is also listed under the TurboQuant fork — an opt-in, off on fresh installs,
 * and not something to choose for the user. The fork is still used when it is
 * the only engine holding a model.
 */
const DEFAULT_LOCAL_ENGINES: readonly string[] = ['llamacpp-upstream', 'mlx']

/**
 * The option that should load fastest and in the least memory: fewest
 * parameters, then fewest bits per weight. Names with no size rank last, and
 * on a full tie the earlier option wins, so `collectReplyModels`' order
 * decides. `options` must not be empty.
 */
function mostCompact(options: readonly ReplyModelOption[]): ReplyModelOption {
  const rank = (option: ReplyModelOption): [number, number] => [
    estimateParamsB(option.modelId) ?? Infinity,
    estimateQuantBits(option.modelId) ?? Infinity,
  ]
  return options.reduce((best, option) => {
    const [bestParams, bestBits] = rank(best)
    const [params, bits] = rank(option)
    return params < bestParams || (params === bestParams && bits < bestBits)
      ? option
      : best
  })
}

/**
 * What to answer with when nothing is selected — decided silently, before
 * any UI, in the order the product set (ATO-461):
 *
 *   1. the last used model, if it is still there;
 *   2. otherwise a connected cloud provider — no memory, instant;
 *   3. otherwise the most compact local model on upstream llama.cpp, or on
 *      MLX when llama.cpp holds none (see {@link mostCompact}).
 *
 * `null` means there is nothing on the device at all. Several local models
 * with no size in their names used to return `null` as well, which put a pick
 * list in front of the user; they now resolve to the first one — the message
 * the user typed going out beats a question about which build should send it.
 *
 * `options` is {@link collectReplyModels}' output, which already puts the
 * last used model first.
 */
export function resolveReplyModel(
  options: readonly ReplyModelOption[],
  lastUsed: LastUsedModel = null
): { option: ReplyModelOption; resolution: ReplyResolution } | null {
  if (options.length === 0) return null

  if (lastUsed) {
    const lastKey = optionKey(lastUsed.provider, lastUsed.model)
    const last = options.find((option) => option.key === lastKey)
    if (last) return { option: last, resolution: 'last_used' }
  }

  const cloud = options.find((option) => option.kind === 'cloud')
  if (cloud) return { option: cloud, resolution: 'cloud' }

  // No cloud row, so every option left is local. The first default engine
  // holding a model is the one to start on; the fork only when none does.
  const onPreferredEngine =
    DEFAULT_LOCAL_ENGINES.map((engine) =>
      options.filter((option) => option.providerName === engine)
    ).find((onEngine) => onEngine.length > 0) ?? options
  return {
    option: mostCompact(onPreferredEngine),
    resolution: options.length === 1 ? 'single_local' : 'smallest_local',
  }
}
