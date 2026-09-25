/**
 * The single place that builds the `start_server` payload and reconciles the
 * bound port afterwards.
 *
 * React-free on purpose: the tray listener and other non-component callers
 * need the same behaviour without pulling in hooks. `useLocalApiServerControl`
 * wraps this with toasts and model loading.
 */

import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { SERVER_START_WATCHDOG_MS, withTimeout } from '@/lib/utils'
import type { DiffusionService } from '@/services/diffusion/types'

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

/** The address a client should dial, from the persisted configuration. */
export function getLocalApiServerUrl(): string {
  const { serverHost, serverPort, apiPrefix } = useLocalApiServer.getState()
  // 0.0.0.0 is a listen-any address, not a dial address.
  const host = serverHost === '0.0.0.0' ? '127.0.0.1' : serverHost
  const prefix = apiPrefix.startsWith('/') ? apiPrefix : `/${apiPrefix}`
  return `http://${host}:${serverPort}${prefix}`
}
