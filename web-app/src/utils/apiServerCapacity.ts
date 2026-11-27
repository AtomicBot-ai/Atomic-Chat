/**
 * The context window of a model the server serves.
 *
 * Two answers, and they can disagree. The model's `ctx_len` setting is what
 * the next load asks for, and it is kept per engine: both llama.cpp providers
 * (and PrismML) list the same models folder, so one model id carries a
 * separate setting in each. The running session is the other answer, and the
 * one clients get: the core grows its window when a request overflows it,
 * `--fit` lets llama.cpp pick one, and a window past the trained one is
 * clamped. Only llama-server's `/props` knows that one, so it is read from
 * there whenever it can be.
 */

import { invoke } from '@tauri-apps/api/core'
import { useModelProvider } from '@/hooks/useModelProvider'
import { findLocalSession } from '@/lib/model-factory'

type ControllerProps = { value?: unknown } | undefined

/**
 * The model's configured context window, if the store knows one: `provider`'s
 * copy of the model when it is given, else the first provider's that has one.
 */
export function getModelContextLength(
  modelId?: string | null,
  provider?: string,
  providers: ModelProvider[] = useModelProvider.getState().providers
): number | undefined {
  if (!modelId) return undefined
  for (const entry of providers) {
    if (provider && entry?.provider !== provider) continue
    const model = entry?.models?.find((m) => m.id === modelId)
    const value = (
      model?.settings?.ctx_len?.controller_props as ControllerProps
    )?.value
    if (typeof value === 'number' && value > 0) return value
  }
  return undefined
}

/** The engines whose sessions are llama-server processes, which answer `/props`. */
const PROPS_PROVIDERS = [
  'llamacpp',
  'llamacpp-upstream',
  'atomic-prism',
] as const
type PropsProvider = (typeof PROPS_PROVIDERS)[number]

const answersProps = (provider: string): provider is PropsProvider =>
  (PROPS_PROVIDERS as readonly string[]).includes(provider)

/**
 * The window in a llama-server `/props` body: the slot's
 * (`default_generation_settings.n_ctx`) first, the server's (`n_ctx`) second.
 */
export function contextFromProps(props: unknown): number | undefined {
  if (!props || typeof props !== 'object') return undefined
  const body = props as {
    default_generation_settings?: { n_ctx?: unknown }
    n_ctx?: unknown
  }
  for (const value of [body.default_generation_settings?.n_ctx, body.n_ctx]) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0)
      return Math.floor(value)
  }
  return undefined
}

/**
 * The window `provider`'s running session of `modelId` was loaded with, from
 * its llama-server's `/props`; `undefined` when the model is not loaded there,
 * the engine is not llama.cpp, or the server cannot say. Never throws.
 */
export async function readLoadedContextLength(
  provider: string,
  modelId: string
): Promise<number | undefined> {
  if (!answersProps(provider)) return undefined
  try {
    const session = await findLocalSession(provider, modelId)
    if (!session?.port) return undefined
    const url = `http://127.0.0.1:${session.port}/props`
    const headers: Record<string, string> = session.api_key
      ? { Authorization: `Bearer ${session.api_key}` }
      : {}
    try {
      const response = await fetch(url, { headers })
      if (!response.ok) return undefined
      return contextFromProps(await response.json())
    } catch {
      // A desktop webview can reject a loopback fetch on CORS even when
      // the authenticated engine is healthy. Use its native loopback transport.
      const body = await invoke<string>('get_local_http', {
        url,
        headers,
        timeoutSecs: 5,
      })
      return contextFromProps(JSON.parse(body))
    }
  } catch {
    return undefined
  }
}
