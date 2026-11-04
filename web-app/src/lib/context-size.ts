import {
  computeNextCtxLen,
  DEFAULT_CTX_LEN,
  EngineManager,
  type AIEngine,
} from '@janhq/core'
import { useHardware } from '@/hooks/useHardware'
import { useModelProvider } from '@/hooks/useModelProvider'
import { readProviderFit } from '@/lib/provider-fit'
import type { ServiceHub } from '@/services'

/** Re-exported so web-app callers have one import for the one default. */
export { DEFAULT_CTX_LEN }

export type GrowContextResult =
  | {
      ok: true
      from: number
      to: number
      /**
       * `fit_ctx` — fit is on and the window grew by raising the model's fit
       * floor; the model has already been reloaded with it.
       */
      via?: 'fit_ctx'
    }
  | {
      ok: false
      /**
       * `fit` — the engine sizes the context itself (`--fit`) on a build where
       * a bigger floor buys nothing (CPU, Apple Silicon); a reload with a
       * bigger `ctx_size` would be sized straight back down.
       * `insufficient_memory` — under fit on a GPU build, the bigger window
       * would not fit the system RAM that is free.
       * `reload_failed` — under fit on a GPU build, the model did not load
       * with the bigger floor; the previous one was put back.
       */
      reason:
        | 'at_max'
        | 'no_model'
        | 'no_provider'
        | 'fit'
        | 'insufficient_memory'
        | 'reload_failed'
      from: number
      max?: number
      /** The window that was tried, when one was. */
      to?: number
    }

/**
 * How a provider's context grows: `ctx_len` (fit off: the ladder writes the
 * window), `fit_ctx` (fit on, GPU build: the ladder raises the model's fit
 * floor, so fit keeps more context and offloads fewer layers) or `fixed`
 * (fit on elsewhere: the engine's choice stands).
 */
export type ContextGrowthMode = 'ctx_len' | 'fit_ctx' | 'fixed'

type ProviderLike = Parameters<typeof readProviderFit>[0]

/** The provider's configured llama.cpp build, e.g. `b11463/win-cuda-12.4-x64`. */
export function readProviderBackend(
  provider: ProviderLike
): string | undefined {
  const value = provider?.settings?.find((s) => s.key === 'version_backend')
    ?.controller_props?.value
  return typeof value === 'string' && value.trim() ? value : undefined
}

/**
 * Whether a llama.cpp build runs on a discrete accelerator whose memory, not
 * the model, bounds the fitted window: CUDA, Vulkan, ROCm/HIP. Context
 * overflow hits a third of the users on these builds and a tenth on CPU
 * builds. Apple Silicon (`macos-arm64`) is not one: its memory is unified,
 * so offloading fewer layers frees nothing for the context.
 */
export function isGpuBackendBuild(versionBackend: string | undefined): boolean {
  const backend = (versionBackend ?? '').toLowerCase().split('/').pop() ?? ''
  return /(^|[-_])(cuda|vulkan|rocm|hip)([-_.\d]|$)/.test(backend)
}

export function contextGrowthMode(provider: ProviderLike): ContextGrowthMode {
  if (readProviderFit(provider) !== true) return 'ctx_len'
  return isGpuBackendBuild(readProviderBackend(provider)) ? 'fit_ctx' : 'fixed'
}

type ModelLike = {
  id: string
  settings?: {
    ctx_len?: { controller_props?: { value?: unknown } }
    auto_increase_ctx_len?: { controller_props?: { value?: unknown } }
    fit_ctx?: { controller_props?: { value?: unknown } }
  }
}

function positiveInt(raw: unknown): number | undefined {
  const value = typeof raw === 'string' ? parseInt(raw, 10) : raw
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined
}

/** Numeric `ctx_len` of a model, or `undefined` when it has none. */
export function readModelCtxLen(model: ModelLike | null | undefined): number | undefined {
  const raw = model?.settings?.ctx_len?.controller_props?.value
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw
  if (typeof raw === 'string') {
    const parsed = parseInt(raw, 10)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return undefined
}

/**
 * The model's own fit floor (`fit_ctx`, tokens), which overrides the
 * provider's for this model; `undefined` when it has none.
 */
export function readModelFitCtx(model: ModelLike | null | undefined): number | undefined {
  return positiveInt(model?.settings?.fit_ctx?.controller_props?.value)
}

/** The provider-level fit floor; llama.cpp's own default (4096) when unset. */
export function readProviderFitCtx(provider: ProviderLike): number {
  const raw = provider?.settings?.find((s) => s.key === 'fit_ctx')
    ?.controller_props?.value
  return positiveInt(raw) ?? FIT_CTX_DEFAULT
}

/** llama.cpp's `--fit-ctx` default: the smallest window fit will settle on. */
export const FIT_CTX_DEFAULT = 4096

/** `auto_increase_ctx_len` of a model; defaults to on. */
export function readAutoIncreaseCtx(model: ModelLike | null | undefined): boolean {
  const raw = model?.settings?.auto_increase_ctx_len?.controller_props?.value
  return typeof raw === 'boolean' ? raw : true
}

/**
 * Training-max context of a local model, asked from its engine. Duck-typed:
 * cloud providers and extensions without `getMaxCtxTrain` yield `undefined`,
 * which leaves the ladder open-ended (as before).
 */
export async function getModelMaxCtxTrain(
  providerId: string,
  modelId: string
): Promise<number | undefined> {
  try {
    const engine = EngineManager.instance().get(providerId) as
      | (AIEngine & {
          getMaxCtxTrain?: (id: string) => Promise<number | undefined>
        })
      | undefined
    if (engine && typeof engine.getMaxCtxTrain === 'function') {
      return await engine.getMaxCtxTrain(modelId)
    }
  } catch (e) {
    console.warn(
      `[auto-expand-ctx] getMaxCtxTrain failed for ${providerId}/${modelId}:`,
      e
    )
  }
  return undefined
}

/**
 * Grow a local model's context window along the shared ladder
 * (`computeNextCtxLen`: `<8192 → 8192 → 32768 → ×1.5`, capped at the
 * training max) and unload the model so the next request reloads it at the
 * new size.
 *
 * With `minCtxLen` the ladder is stepped until the window is at least that
 * large (or the cap is hit), so a pre-flight that already knows the prompt
 * size pays for a single reload instead of one per step.
 *
 * Only the provider store and the engine session are touched; regenerating
 * or re-sending is the caller's business.
 */
export async function growModelContext(args: {
  providerId: string
  modelId: string
  serviceHub: ServiceHub
  minCtxLen?: number
}): Promise<GrowContextResult> {
  const { providerId, modelId, serviceHub, minCtxLen } = args
  const { getProviderByName } = useModelProvider.getState()
  const provider = getProviderByName(providerId)
  if (!provider) return { ok: false, reason: 'no_provider', from: 0 }

  const modelIndex = provider.models.findIndex((m) => m.id === modelId)
  if (modelIndex === -1) return { ok: false, reason: 'no_model', from: 0 }
  const model = provider.models[modelIndex]

  const from = readModelCtxLen(model as ModelLike) ?? DEFAULT_CTX_LEN
  const mode = contextGrowthMode(provider)
  if (mode === 'fixed') {
    return { ok: false, reason: 'fit', from }
  }
  if (mode === 'fit_ctx') {
    return growFitFloor({
      providerId,
      modelId,
      serviceHub,
      minCtxLen,
      // Under fit `ctx_len` is the window the last load settled on (the
      // engine mirrors it back), and never less than the floor fit kept.
      from: Math.max(
        from,
        readModelFitCtx(model as ModelLike) ?? readProviderFitCtx(provider)
      ),
    })
  }
  const maxCtxLen = await getModelMaxCtxTrain(providerId, modelId)

  const to = nextLadderStep(from, maxCtxLen, minCtxLen)
  if (to <= from) {
    return { ok: false, reason: 'at_max', from, max: maxCtxLen }
  }

  setModelContextLength(providerId, modelId, to)

  // Scoped to this provider: an unscoped `stopModel` would also unload a
  // copy of the model another engine may be serving.
  await serviceHub.models().stopModel(modelId, providerId)

  return { ok: true, from, to }
}

/** The ladder from `from`, one step or, with `minCtxLen`, until it is reached or capped. */
function nextLadderStep(
  from: number,
  maxCtxLen: number | undefined,
  minCtxLen: number | undefined
): number {
  let to = from
  for (;;) {
    const next = computeNextCtxLen(to, maxCtxLen)
    if (next <= to) break
    to = next
    if (minCtxLen === undefined || to >= minCtxLen) break
  }
  return to
}

/**
 * Bytes one token of context is reckoned at for the memory check: f16 K and
 * V of an 8B-class GQA model (32 layers × 8 KV heads × 128 dims × 2 × 2 B).
 * A rough figure — quantized caches need less, 70B-class models more.
 */
export const KV_BYTES_PER_TOKEN_ESTIMATE = 128 * 1024
/** Share of the free system RAM a growth may claim. */
const RAM_HEADROOM = 0.8
const MIB = 1024 * 1024

/**
 * Free system RAM in MiB: a fresh reading when the hardware service answers
 * quickly, else the last one in the hardware store; `undefined` when neither
 * knows (then the growth is just tried).
 */
async function freeSystemRamMiB(serviceHub: ServiceHub): Promise<number | undefined> {
  const fromUsage = (usage: { total_memory?: number; used_memory?: number } | null | undefined) =>
    usage && (usage.total_memory ?? 0) > 0
      ? Math.max(0, (usage.total_memory ?? 0) - (usage.used_memory ?? 0))
      : undefined
  try {
    const hardware = serviceHub.hardware?.()
    if (hardware && typeof hardware.getSystemUsage === 'function') {
      const usage = await Promise.race([
        hardware.getSystemUsage(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
      ])
      const free = fromUsage(usage)
      if (free !== undefined) return free
    }
  } catch {
    // Fall through to the stored reading.
  }
  const state = useHardware.getState()
  const stored = fromUsage(state.systemUsage)
  if (stored !== undefined) return stored
  const available = state.hardwareData?.ram?.available
  return typeof available === 'number' && available > 0 ? available : undefined
}

/**
 * Floors that did not load, per model, so the pre-flight and the thread page
 * do not reload into the same failure twice in a row. Kept for a few minutes:
 * memory frees up when other apps close.
 */
const failedFitFloors = new Map<string, { to: number; at: number }>()
const FAILED_FIT_FLOOR_TTL_MS = 5 * 60 * 1000

/** For tests. */
export function resetFailedFitFloors(): void {
  failedFitFloors.clear()
}

/**
 * Under fit on a GPU build: raise the model's fit floor (`fit_ctx`) to the
 * next ladder step and reload, so fit keeps more context and offloads fewer
 * layers. `ctx_len` is set to the floor too, so the pre-flight of the retry
 * reads the window it is about to get; the engine mirrors the real one back
 * after the load. A floor that does not load is reverted.
 */
async function growFitFloor(args: {
  providerId: string
  modelId: string
  serviceHub: ServiceHub
  minCtxLen?: number
  from: number
}): Promise<GrowContextResult> {
  const { providerId, modelId, serviceHub, minCtxLen, from } = args
  const maxCtxLen = await getModelMaxCtxTrain(providerId, modelId)
  const to = nextLadderStep(from, maxCtxLen, minCtxLen)
  if (to <= from) {
    return { ok: false, reason: 'at_max', from, max: maxCtxLen }
  }

  const key = `${providerId}::${modelId}`
  const failed = failedFitFloors.get(key)
  if (failed && Date.now() - failed.at < FAILED_FIT_FLOOR_TTL_MS && to >= failed.to) {
    return { ok: false, reason: 'reload_failed', from, to, max: maxCtxLen }
  }

  const freeMiB = await freeSystemRamMiB(serviceHub)
  const neededMiB = ((to - from) * KV_BYTES_PER_TOKEN_ESTIMATE) / MIB
  if (freeMiB !== undefined && neededMiB > freeMiB * RAM_HEADROOM) {
    console.info(
      `[auto-expand-ctx] ${providerId}/${modelId}: ${from} → ${to} needs ~${Math.round(neededMiB)} MiB, ${Math.round(freeMiB)} MiB RAM free`
    )
    return { ok: false, reason: 'insufficient_memory', from, to, max: maxCtxLen }
  }

  const previousFloor = readModelSetting(providerId, modelId, 'fit_ctx')
  const previousCtxLen = readModelSetting(providerId, modelId, 'ctx_len')
  setModelFitCtx(providerId, modelId, to)
  setModelContextLength(providerId, modelId, to)
  await serviceHub.models().stopModel(modelId, providerId)
  try {
    const provider = useModelProvider.getState().getProviderByName(providerId)
    if (!provider) throw new Error(`Provider '${providerId}' not found`)
    await serviceHub.models().startModel(provider, modelId)
  } catch (error) {
    console.warn(
      `[auto-expand-ctx] ${providerId}/${modelId} did not load with fit_ctx ${to}:`,
      error
    )
    failedFitFloors.set(key, { to, at: Date.now() })
    restoreModelSetting(providerId, modelId, 'fit_ctx', previousFloor)
    restoreModelSetting(providerId, modelId, 'ctx_len', previousCtxLen)
    return { ok: false, reason: 'reload_failed', from, to, max: maxCtxLen }
  }
  failedFitFloors.delete(key)
  return { ok: true, from, to, via: 'fit_ctx' }
}

type StoredSetting = Record<string, unknown> | undefined

function readModelSetting(
  providerId: string,
  modelId: string,
  key: string
): StoredSetting {
  const provider = useModelProvider.getState().getProviderByName(providerId)
  const model = provider?.models.find((m) => m.id === modelId)
  return (model?.settings as Record<string, StoredSetting> | undefined)?.[key]
}

/** Put a model setting back as it was, removing it when it was not there. */
function restoreModelSetting(
  providerId: string,
  modelId: string,
  key: string,
  previous: StoredSetting
): void {
  updateModelSettings(providerId, modelId, (settings) => {
    const next = { ...settings }
    if (previous === undefined) delete next[key]
    else next[key] = previous
    return next
  })
}

function updateModelSettings(
  providerId: string,
  modelId: string,
  update: (settings: Record<string, unknown>) => Record<string, unknown>
): boolean {
  const { getProviderByName, updateProvider } = useModelProvider.getState()
  const provider = getProviderByName(providerId)
  const modelIndex = provider?.models.findIndex((m) => m.id === modelId) ?? -1
  if (!provider || modelIndex === -1) return false
  const model = provider.models[modelIndex]
  const updatedModels = [...provider.models]
  updatedModels[modelIndex] = {
    ...model,
    settings: update({ ...(model.settings ?? {}) }),
  } as typeof model
  updateProvider(provider.provider, { models: updatedModels })
  return true
}

/**
 * Set the model-level fit floor (`fit_ctx`, tokens, as the string the core's
 * llama.cpp config carries it in) for `modelId`; it overrides the provider's
 * for this model on the next load. Nothing is reloaded.
 */
export function setModelFitCtx(
  providerId: string,
  modelId: string,
  value: number
): boolean {
  return updateModelSettings(providerId, modelId, (settings) => {
    const current = settings.fit_ctx as
      | { controller_props?: Record<string, unknown> }
      | undefined
    return {
      ...settings,
      fit_ctx: {
        key: 'fit_ctx',
        title: 'Fit Minimum Context Size',
        description:
          'Smallest context (tokens) fit keeps for this model; overrides the engine setting. Raised automatically when a chat outgrows the window.',
        controller_type: 'input',
        ...(current ?? {}),
        controller_props: {
          placeholder: String(FIT_CTX_DEFAULT),
          type: 'number',
          textAlign: 'right',
          ...(current?.controller_props ?? {}),
          value: String(value),
        },
      },
    }
  })
}

/**
 * Set `provider`'s `ctx_len` for `modelId` in the provider store, which the
 * next load reads. Nothing is reloaded. Whether it did (the model is listed).
 */
export function setModelContextLength(
  providerId: string,
  modelId: string,
  value: number
): boolean {
  const { getProviderByName, updateProvider } = useModelProvider.getState()
  const provider = getProviderByName(providerId)
  const modelIndex = provider?.models.findIndex((m) => m.id === modelId) ?? -1
  if (!provider || modelIndex === -1) return false
  const model = provider.models[modelIndex]
  const updatedModel = {
    ...model,
    settings: {
      ...model.settings,
      ctx_len: {
        ...(model.settings?.ctx_len ?? {}),
        controller_props: {
          ...(model.settings?.ctx_len?.controller_props ?? {}),
          value,
        },
      },
    },
  }
  const updatedModels = [...provider.models]
  updatedModels[modelIndex] = updatedModel as typeof model
  updateProvider(provider.provider, { models: updatedModels })
  return true
}
