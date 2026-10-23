/**
 * The single place that builds the `start_server` payload and reconciles the
 * bound port afterwards.
 *
 * React-free on purpose: the tray listener and other non-component callers
 * need the same behaviour without pulling in hooks. `useLocalApiServerControl`
 * wraps this with toasts and model loading.
 */

import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'

import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { SERVER_START_WATCHDOG_MS, withTimeout } from '@/lib/utils'
import type { DiffusionService } from '@/services/diffusion/types'
import type {
  EmbeddingService,
  EmbeddingState,
} from '@/services/embedding/types'

/**
 * Starts the proxy with the persisted configuration and returns the port it
 * actually bound to.
 *
 * Note: `corsEnabled` and `verboseLogs` are intentionally not sent. The IPC
 * shim in `lib/service.ts` drops them and the Rust `StartServerConfig` has no
 * such fields — passing them only made call sites look like they mattered.
 */
export async function startLocalApiServer(): Promise<number | undefined> {
  const config = useLocalApiServer.getState()
  const call = window.core?.api?.startServer({
    host: config.serverHost,
    port: config.serverPort,
    prefix: config.apiPrefix,
    apiKey: config.apiKey,
    trustedHosts: config.trustedHosts,
    proxyTimeout: config.proxyTimeout,
  }) as Promise<number> | undefined

  if (!call) return undefined

  // ATO-270: the bind has no timeout of its own, so a call stuck in backend
  // preparation would leave the button spinning on "Starting Server" forever.
  const actualPort = await withTimeout(
    call,
    SERVER_START_WATCHDOG_MS,
    'Timed out waiting for the Local API Server to start.'
  )

  // Mobile starts from port 0 (auto-assign), so persist whatever the proxy
  // actually bound to.
  if (actualPort && actualPort !== config.serverPort) {
    useLocalApiServer.getState().setServerPort(actualPort)
  }
  return actualPort
}

export async function stopLocalApiServer(): Promise<void> {
  await window.core?.api?.stopServer()
}

/**
 * Start/stop while keeping `serverStatus` in step, including on failure.
 * Rethrows so callers can surface their own error UI.
 */
export async function setLocalApiServerRunning(running: boolean): Promise<void> {
  const { setServerStatus } = useAppState.getState()
  setServerStatus('pending')
  try {
    if (running) {
      await startLocalApiServer()
      setServerStatus('running')
    } else {
      await stopLocalApiServer()
      setServerStatus('stopped')
    }
  } catch (error) {
    // Reset rather than leaving the UI stuck in a permanent pending state.
    setServerStatus('stopped')
    throw error
  }
}

/**
 * Whether an image or video model is resident (or on its way in). The core
 * serves `/v1/images/generations` and `/v1/videos` from such a model with no
 * chat model loaded, so the server has something to answer without one — and
 * loading one for it could unload this model to make room on the GPU. Anything
 * that cannot tell reads as "no".
 */
export async function hasResidentMediaModel(
  diffusion: Pick<DiffusionService, 'isSupported' | 'getStatus'>
): Promise<boolean> {
  try {
    if (!diffusion.isSupported()) return false
    const status = await diffusion.getStatus()
    return (
      status.configured &&
      (status.model.state === 'loaded' || status.model.state === 'loading')
    )
  } catch {
    return false
  }
}

/** An enabled embedding model in these states answers `/v1/embeddings`; `idle` starts on the request. */
const EMBEDDING_SERVING_STATES: ReadonlySet<EmbeddingState> = new Set([
  'idle',
  'starting',
  'ready',
  'restarting',
])

/**
 * Whether an embedding model is switched on. The core serves
 * `/v1/embeddings` from it with no chat model loaded, so the server has
 * something to answer without one — and loading one for it could take the
 * memory the embedding model runs in. Anything that cannot tell reads as
 * "no".
 */
export async function hasResidentEmbeddingModel(
  embedding: Pick<EmbeddingService, 'isSupported' | 'getStatus'>
): Promise<boolean> {
  try {
    if (!embedding.isSupported()) return false
    const status = await embedding.getStatus()
    return status.enabled && EMBEDDING_SERVING_STATES.has(status.state)
  } catch {
    return false
  }
}

/**
 * An image or video model just became resident. Outside clients reach it only
 * through the Local API Server, so the server comes up with it the way it does
 * for a local chat model (`switchModel.ts`): when auto-start is on. A server
 * that is up or coming up is left alone, and no chat model is loaded for it.
 * Never the reason a model load fails.
 */
export async function raiseLocalApiServerForMediaModel(): Promise<void> {
  if (useAppState.getState().serverStatus !== 'stopped') return
  if (!useLocalApiServer.getState().enableOnStartup) return
  try {
    await setLocalApiServerRunning(true)
  } catch (error) {
    console.warn(
      '[LocalAPI] could not start the server for the image model:',
      error
    )
  }
}

/**
 * Set in the main window's sessionStorage, which a reload keeps and an app
 * restart does not: "this run of the app has had its launch".
 */
const LAUNCH_AUTOSTART_MARKER = 'atomic_local_api_launch_autostart'

/** Where sessionStorage cannot be used: once per page load. */
let launchAutoStartClaimed = false

/**
 * Whether this window may start the server for "Start automatically": the
 * main window, once per run of the app. Every window mounts the startup code,
 * and neither a chat opened in its own window nor a reload of the main one is
 * a launch: after the user's Stop, the server stays stopped until they start
 * it or the app is opened again.
 */
export function claimLaunchAutoStart(): boolean {
  try {
    if (getCurrentWebviewWindow().label !== 'main') return false
  } catch {
    // No Tauri window (the web build): there is only the one.
  }
  try {
    if (sessionStorage.getItem(LAUNCH_AUTOSTART_MARKER) !== null) return false
    sessionStorage.setItem(LAUNCH_AUTOSTART_MARKER, '1')
    return true
  } catch {
    if (launchAutoStartClaimed) return false
    launchAutoStartClaimed = true
    return true
  }
}

/** The address a client should dial, from the persisted configuration. */
export function getLocalApiServerUrl(): string {
  const { serverHost, serverPort, apiPrefix } = useLocalApiServer.getState()
  // 0.0.0.0 is a listen-any address, not a dial address.
  const host = serverHost === '0.0.0.0' ? '127.0.0.1' : serverHost
  const prefix = apiPrefix.startsWith('/') ? apiPrefix : `/${apiPrefix}`
  return `http://${host}:${serverPort}${prefix}`
}

/** The user message of the Connections page's example request. */
export const TEST_REQUEST_MESSAGE = 'Hello'

/** The test asks for a short answer: it proves the model replies, not how well. */
export const TEST_REQUEST_MAX_TOKENS = 16

/** A local model on a busy or small machine can take a while to answer even this. */
const TEST_REQUEST_TIMEOUT_SECS = 60

export type LocalApiServerTestResult =
  | { ok: true; latencyMs: number; model: string }
  | {
      ok: false
      latencyMs: number
      model: string
      httpStatus: number | null
      message: string
    }

/**
 * The chat completion the Connections page shows — its model and message,
 * with `max_tokens` kept small — sent through the Rust HTTP client (no webview
 * CORS). It proves the address, the prefix and the key, and that the model
 * answers. It is a real request, so Activity lists it.
 */
export async function sendTestChatCompletion(
  baseUrl: string,
  apiKey: string,
  model: string
): Promise<LocalApiServerTestResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey}`
  const started = performance.now()
  const elapsed = () => Math.round(performance.now() - started)
  try {
    // `post_local_http` rejects any status from 400 up, with the status first.
    await invoke<string>('post_local_http', {
      url: `${baseUrl.replace(/\/+$/, '')}/chat/completions`,
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: TEST_REQUEST_MESSAGE }],
        max_tokens: TEST_REQUEST_MAX_TOKENS,
        stream: false,
      }),
      timeoutSecs: TEST_REQUEST_TIMEOUT_SECS,
    })
    // The model is named as asked: engines report their own id (a file path,
    // an alias) in the answer, which says less to the reader.
    return { ok: true, latencyMs: elapsed(), model }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status = /^HTTP (\d{3})/.exec(message)?.[1]
    return {
      ok: false,
      latencyMs: elapsed(),
      model,
      httpStatus: status ? Number(status) : null,
      message,
    }
  }
}
