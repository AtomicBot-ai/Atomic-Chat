import { DEFAULT_CTX_LEN } from '@janhq/core'
import { isManagedProvider } from '@/lib/managed-engines'
import { isContextLimitError } from '@/utils/error'

/**
 * How a provider's context window can change: `reload` — the model reloads with a larger window in
 * seconds (llama.cpp, MLX); `restart` — the engine process or container must restart with a new
 * setting, which takes minutes (managed engines, Strata, FastFlowLM, GenieX, LiteRT-LM); `fixed` —
 * the window belongs to the model or the platform (Foundry Local, Apple Foundation Models).
 *
 * Mirrors `ContextResizeMode` of the core's context contract (`@atomic-chat/core/contracts`). The
 * pinned core does not export it yet; replace this with the import once the app pins the core
 * release that does.
 */
export type ContextResizeMode = 'reload' | 'restart' | 'fixed'

const RELOAD_PROVIDERS: ReadonlySet<string> = new Set([
  'llamacpp-upstream',
  'llamacpp',
  'atomic-prism',
  'mlx',
])
const FIXED_PROVIDERS: ReadonlySet<string> = new Set([
  'foundry-local',
  'foundation-models',
])
const RESTART_PROVIDERS: ReadonlySet<string> = new Set([
  'strata',
  'fastflowlm',
  'geniex',
  'litert-lm',
])

/**
 * How `providerId`'s window can change; `undefined` for a provider that is not a local engine
 * (every cloud provider, a user-added endpoint, an unknown id). Mirrors the core's
 * `contextResizeMode`.
 */
export function contextResizeMode(
  providerId: string | undefined
): ContextResizeMode | undefined {
  if (!providerId) return undefined
  if (RELOAD_PROVIDERS.has(providerId)) return 'reload'
  if (RESTART_PROVIDERS.has(providerId) || isManagedProvider(providerId)) {
    return 'restart'
  }
  if (FIXED_PROVIDERS.has(providerId)) return 'fixed'
  return undefined
}

export type ContextSupport = {
  resize: ContextResizeMode | undefined
  /**
   * Whether the app may grow the window by itself when a chat outgrows it. Only an engine that
   * reloads in seconds does: a restart takes minutes, a fixed window cannot change, and a cloud
   * provider's window is not the app's to change.
   */
  canExpand: boolean
}

/** What the app may do about `providerId`'s context window. */
export function contextSupport(providerId: string | undefined): ContextSupport {
  const resize = contextResizeMode(providerId)
  return { resize, canExpand: resize === 'reload' }
}

/**
 * Whether a failed chat turn grows its model's window and runs again by itself: the failure is a
 * context overflow, the engine reloads in seconds, and the model's auto-increase is on. A cloud
 * overflow never does — the app has no window of its own to write for it.
 */
export function growsAfterError(args: {
  providerId: string | undefined
  error: unknown
  /** The model's `auto_increase_ctx_len` (`readAutoIncreaseCtx`). */
  autoIncrease: boolean
}): boolean {
  return (
    args.autoIncrease &&
    contextSupport(args.providerId).canExpand &&
    isContextLimitError(args.error)
  )
}

/**
 * The window a turn of `providerId`'s model ran in, as far as the app knows it: the model's
 * `ctx_len` (`readModelCtxLen`), or for an engine that reloads the window the engine's default
 * when none is set. `undefined` when the window is unknown (a cloud provider, an unknown engine, a
 * managed engine whose model names none), so a `finish_reason: 'length'` is never read as an
 * overflow of a window nobody measured.
 */
export function knownContextWindow(
  providerId: string | undefined,
  ctxLen: number | undefined
): number | undefined {
  const { resize } = contextSupport(providerId)
  if (!resize) return undefined
  if (ctxLen !== undefined && ctxLen > 0) return ctxLen
  return resize === 'reload' ? DEFAULT_CTX_LEN : undefined
}

/** Share of the window a turn must fill for `finish_reason: 'length'` to count as an overflow. */
const LENGTH_OVERFLOW_SHARE = 0.9

/**
 * Whether a turn that finished with `finish_reason: 'length'` ran out of context rather than
 * reaching its own answer cap: it used most of a window the app knows. A provider whose window
 * is unknown never overflows here, whatever the token counts say.
 */
export function isLengthContextOverflow(args: {
  providerId: string | undefined
  /** The model's `ctx_len`, when it has one. */
  ctxLen: number | undefined
  totalTokens: number
}): { overflow: boolean; window: number | undefined } {
  const window = knownContextWindow(args.providerId, args.ctxLen)
  return {
    overflow:
      window !== undefined &&
      args.totalTokens >= window * LENGTH_OVERFLOW_SHARE,
    window,
  }
}
