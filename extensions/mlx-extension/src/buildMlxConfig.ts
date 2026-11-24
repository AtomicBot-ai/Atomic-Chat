/** The MLX launch settings the core turns into `mlx-server` arguments. */
export type MlxConfig = {
  /** Absent when nothing names a window: the core then sizes it to this Mac. */
  ctx_size?: number
  draft_model_path: string
  block_size: number
  /** Drafter family — "dflash" (default) or "mtp" (Gemma 4 assistant); "" reads as "dflash". */
  draft_kind: string
  /**
   * KV-cache quantization bit-width (e.g. 3.5 for TurboQuant). 0 disables it;
   * `--kv-bits` goes out only when this is > 0 and a real scheme is set.
   */
  kv_bits: number
  /** "" / "off" (no quantization, default), "uniform" or "turboquant", passed verbatim. */
  kv_quant_scheme: string
}

export type MlxDraftKind = 'dflash' | 'mtp' | 'eagle3'

/**
 * Settings arrive as whatever the settings machinery stored: the number
 * inputs in `settings.json` ship string defaults ("3.5", "16") and the UI's
 * number field hands back strings too. Every numeric knob goes through
 * {@link asNumber}; a `typeof === 'number'` check silently threw the value
 * away — which is how KV-cache quantisation could never switch on
 * (ATO-466).
 */
type Numeric = number | string

export interface MlxExtensionConfigInput {
  ctx_size?: Numeric
  draft_model_path?: string
  block_size?: Numeric
  dflash_enabled?: boolean
  mtp_enabled?: boolean
  mtp_block_size?: Numeric
  eagle3_enabled?: boolean
  eagle3_block_size?: Numeric
  kv_bits?: Numeric
  kv_quant_scheme?: string
}

export interface MlxDraftSelection {
  draftKind: MlxDraftKind
  draftPath: string
  blockSize: number
}

/** A finite number from a number or a numeric string; otherwise `undefined`. */
export function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

export function selectMlxDraftSettings(
  config: MlxExtensionConfigInput
): MlxDraftSelection {
  if (config.mtp_enabled) {
    return {
      draftKind: 'mtp',
      draftPath: config.draft_model_path ?? '',
      blockSize: asNumber(config.mtp_block_size) ?? 4,
    }
  }
  if (config.eagle3_enabled) {
    return {
      draftKind: 'eagle3',
      draftPath: config.draft_model_path ?? '',
      blockSize: asNumber(config.eagle3_block_size) ?? 0,
    }
  }
  if (config.dflash_enabled) {
    return {
      draftKind: 'dflash',
      draftPath: config.draft_model_path ?? '',
      blockSize: asNumber(config.block_size) ?? 16,
    }
  }
  return {
    draftKind: 'dflash',
    draftPath: '',
    blockSize: 0,
  }
}

/**
 * The context window to load with.
 *
 * An explicit, valid `ctx_size` (a user-pinned value, or the auto-increase
 * override) wins, clamped to the training maximum when that is known — MLX
 * never clamped, unlike llama.cpp, so it could ask for a window the model
 * was not trained to hold. Unset stays unset: the core then loads the
 * largest window this Mac holds for the model, never above its training
 * maximum (`atomic-chat-core` ADR 2026-11-23 "Default every engine to the
 * largest window that fits", which replaces the `min(trainMax, 16384)`
 * default of ADR 2026-06-15).
 */
export function resolveMlxCtxSize(
  ctxSize: Numeric | undefined,
  maxCtxTrain: number | undefined
): number | undefined {
  const trainMax =
    typeof maxCtxTrain === 'number' && maxCtxTrain > 0 ? maxCtxTrain : undefined
  const explicit = asNumber(ctxSize)
  if (explicit === undefined || explicit <= 0) return undefined
  return trainMax ? Math.min(explicit, trainMax) : explicit
}

export function buildMlxConfig(
  config: MlxExtensionConfigInput,
  draft: MlxDraftSelection,
  options: { maxCtxTrain?: number } = {}
): MlxConfig {
  const draftPath = draft.draftPath.trim()
  const kvScheme =
    config.kv_quant_scheme === 'uniform' ||
    config.kv_quant_scheme === 'turboquant'
      ? config.kv_quant_scheme
      : ''
  const kvBitsRaw = asNumber(config.kv_bits)
  const kvBits =
    kvScheme && kvBitsRaw !== undefined && kvBitsRaw > 0 ? kvBitsRaw : 0

  const ctxSize = resolveMlxCtxSize(config.ctx_size, options.maxCtxTrain)
  return {
    ...(ctxSize !== undefined ? { ctx_size: ctxSize } : {}),
    draft_model_path: draftPath,
    block_size: draftPath ? draft.blockSize : 0,
    draft_kind: draftPath ? draft.draftKind : 'dflash',
    kv_bits: kvBits,
    kv_quant_scheme: kvBits > 0 ? kvScheme : '',
  }
}
