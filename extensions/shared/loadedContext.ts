/**
 * The context window a llama.cpp load really got, told back to the web app (ATO-465).
 *
 * With "Fit context to device memory" on, the core sends llama-server no `--ctx-size`: an explicit
 * size would switch llama.cpp's context fitting off, so the engine picks the window itself, starting
 * from the model's trained context. The model's `ctx_len` setting (16384 by default) is then only
 * what the load asked for, and the context controls would keep showing it while the server runs
 * with something else — 128000 for LFM2.5 1.2B on an 8 GB Mac. The core may also clamp an asked-for
 * window to the trained one. So after a chat load the extension reads `/props` from the server and,
 * when the window differs from the one it asked for, hands the real one to the web app, which writes
 * it into the model's `ctx_len` (the `OnAutoIncreasedCtxLen` path the context ladder already uses).
 *
 * TurboQuant keeps its own copy of this (`syncLoadedCtxSize`); the upstream and PrismML extensions
 * lost theirs when the core took over their loads. Like the other shared helpers it imports
 * nothing: the extension passes `fetch` and the notification.
 */

/** The part of a load's `SessionInfo` this needs. */
export interface LoadedServer {
  model_id: string
  port: number
  api_key: string
}

/** A positive whole number of tokens, or `undefined`. */
function positiveTokens(value: unknown): number | undefined {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}

/**
 * The window in a llama-server `/props` body: the slot's (`default_generation_settings.n_ctx`)
 * first, the server's (`n_ctx`) second, `undefined` when neither is a positive number.
 */
export function contextFromProps(props: unknown): number | undefined {
  if (!props || typeof props !== 'object') return undefined
  const body = props as { default_generation_settings?: { n_ctx?: unknown }; n_ctx?: unknown }
  return positiveTokens(body.default_generation_settings?.n_ctx) ?? positiveTokens(body.n_ctx)
}

/** Ask the running server for its window; `undefined` when it cannot say. Never throws. */
export async function readLoadedContext(
  server: LoadedServer,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>
): Promise<number | undefined> {
  try {
    const response = await fetchImpl(`http://localhost:${server.port}/props`, {
      headers: { Authorization: `Bearer ${server.api_key}` },
    })
    if (!response?.ok) return undefined
    return contextFromProps(await response.json())
  } catch {
    return undefined
  }
}

export interface MirrorLoadedContextOptions {
  server: LoadedServer
  /** The `ctx_size` the load asked for (the model's `ctx_len`); anything unreadable counts as unknown. */
  requested: unknown
  fetch: (url: string, init: RequestInit) => Promise<Response>
  /** Tell the web app; called only when the window differs from the one asked for. */
  notify: (modelId: string, ctxLen: number) => void | Promise<void>
  warn?: (message: string) => void
}

/**
 * After a chat load: the window the server got, passed to `notify` when it is not the one the load
 * asked for. Resolves to that window, or `undefined` when nothing was told. Never throws — a probe
 * that fails leaves the controls as they were, which is no worse than before the load.
 */
export async function mirrorLoadedContext(
  options: MirrorLoadedContextOptions
): Promise<number | undefined> {
  const loaded = await readLoadedContext(options.server, options.fetch)
  if (loaded === undefined) {
    options.warn?.(`Could not read the loaded context of ${options.server.model_id} from /props`)
    return undefined
  }
  if (loaded === positiveTokens(options.requested)) return undefined
  try {
    await options.notify(options.server.model_id, loaded)
  } catch (error) {
    options.warn?.(`Could not tell the app the loaded context of ${options.server.model_id}: ${error}`)
    return undefined
  }
  return loaded
}
