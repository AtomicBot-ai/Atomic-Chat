/**
 * Whether a load names the model's context window or leaves it to the core.
 *
 * The core gives a model the largest window that fits this device when a load names none
 * (`atomic-chat-core` ADR 2026-11-23 "Default every engine to the largest window that fits"):
 * llama.cpp with fit off and MLX run at that plan, and llama.cpp with fit on a discrete GPU keeps
 * it as its `--fit-ctx` floor. Every model the app lists carries a `ctx_len`, seeded with the old
 * default (16384; 8192 in older releases), and sending it as `ctx_size` pinned every load to that
 * number. So a `ctx_len` nobody chose — not marked {@link CTX_LEN_USER_SET_KEY} and still on an
 * old default — is not sent. Every other value is: one the user committed, a window the context
 * growth wrote, or the one a load got that the extension mirrored back.
 */

/** Model setting that marks `ctx_len` as chosen by the user. Never sent to an engine. */
export const CTX_LEN_USER_SET_KEY = 'ctx_len_user_set'

/** Engines whose core load plans the window when no `ctx_size` arrives. */
const PLANNED_CONTEXT_PROVIDERS: ReadonlySet<string> = new Set([
  'llamacpp',
  'llamacpp-upstream',
  'atomic-prism',
  'mlx',
])

/** The `ctx_len` every listed model was seeded with: 16384 today, 8192 in older releases. */
const LEGACY_DEFAULT_CTX_LENS: ReadonlySet<number> = new Set([16384, 8192])

type SettingsLike =
  | Record<string, { controller_props?: { value?: unknown } } | undefined>
  | undefined

/** Whether the user chose the model's `ctx_len` (slider, model settings, run settings). */
export function isCtxLenUserSet(settings: SettingsLike): boolean {
  return settings?.[CTX_LEN_USER_SET_KEY]?.controller_props?.value === true
}

/**
 * Whether a load of `providerId` sends the model's `ctx_len` as `ctx_size`: always, except for a
 * planning engine whose `ctx_len` nobody chose and is still an old default.
 */
export function sendsCtxSize(
  providerId: string,
  settings: SettingsLike
): boolean {
  if (!PLANNED_CONTEXT_PROVIDERS.has(providerId)) return true
  if (isCtxLenUserSet(settings)) return true
  const raw = settings?.ctx_len?.controller_props?.value
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
  return !(typeof value === 'number' && LEGACY_DEFAULT_CTX_LENS.has(value))
}

/** The marker a user's commit of `ctx_len` stores next to it. */
export function ctxLenUserSetSetting(): ProviderSetting {
  return {
    key: CTX_LEN_USER_SET_KEY,
    title: 'Context Size Chosen By User',
    description:
      'Set when the context size was chosen by hand. Without it, a default context size is left to the engine, which sizes the window to this device.',
    controller_type: 'checkbox',
    controller_props: { value: true },
  }
}

/** Engines that have no `/props` to mirror a planned window from, so the core's measure is asked. */
const MEASURED_WINDOW_PROVIDERS: ReadonlySet<string> = new Set(['mlx'])

/**
 * After a load that left the window to the core, write the window the core chose into the model's
 * `ctx_len`, so the context controls show the window the engine runs — what the llama.cpp
 * extensions already do from `/props` (ADR 2026-10-26). MLX has no `/props`; the core's
 * `context/measure` reports the session's window. Never sets {@link CTX_LEN_USER_SET_KEY}.
 * Resolves to the window written, or `undefined` when nothing was. Never throws.
 */
export async function mirrorPlannedWindow(
  providerId: string,
  modelId: string,
  deps: {
    measure: (
      providerId: string,
      modelId: string
    ) => Promise<{ windowTokens?: number } | undefined>
    currentCtxLen: () => number | undefined
    write: (window: number) => void
  }
): Promise<number | undefined> {
  if (!MEASURED_WINDOW_PROVIDERS.has(providerId)) return undefined
  try {
    const window = (await deps.measure(providerId, modelId))?.windowTokens
    if (window === undefined || !(window > 0)) return undefined
    if (deps.currentCtxLen() === window) return undefined
    deps.write(window)
    return window
  } catch {
    return undefined
  }
}
