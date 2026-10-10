import { toast } from 'sonner'
import i18n from '@/i18n/setup'

/**
 * MCP servers the user is turning on right now. A message sent while one is
 * still connecting would go out without its tools, so a send first waits for
 * these (bounded, see `awaitMcpActivations`). Kept outside React: the toggle
 * that started an activation can unmount (the home page navigates to the new
 * thread) while the activation keeps running.
 */
const pending = new Map<string, Promise<void>>()

/** How long a send waits for connecting servers, below the 30 s handshake. */
export const MCP_ACTIVATION_WAIT_MS = 12_000

/**
 * Register `work` as the activation of server `key` until it settles. A
 * failure is the caller's to report; a waiting send just proceeds.
 */
export function trackMcpActivation(key: string, work: Promise<unknown>) {
  const settled: Promise<void> = work
    .then(
      () => undefined,
      () => undefined
    )
    .finally(() => {
      if (pending.get(key) === settled) pending.delete(key)
    })
  pending.set(key, settled)
}

export type McpActivationWait = 'none' | 'settled' | 'timeout' | 'aborted'

/** Wait until every activation in flight has settled, the timeout passes, or `signal` aborts. */
export async function awaitMcpActivations({
  timeoutMs = MCP_ACTIVATION_WAIT_MS,
  signal,
}: {
  timeoutMs?: number
  signal?: AbortSignal
} = {}): Promise<McpActivationWait> {
  if (pending.size === 0) return 'none'
  if (signal?.aborted) return 'aborted'
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      Promise.all(pending.values()).then(() => 'settled' as const),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs)
      }),
      new Promise<'aborted'>((resolve) => {
        onAbort = () => resolve('aborted')
        signal?.addEventListener('abort', onAbort, { once: true })
      }),
    ])
  } finally {
    clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * What a send does before collecting tools: wait for servers still
 * connecting, and say so when one did not come up in time (the send then
 * goes out without its tools).
 */
export async function settleMcpActivationsBeforeSend(signal?: AbortSignal) {
  const result = await awaitMcpActivations({ signal })
  if (result === 'timeout') {
    toast.warning(i18n.t('common:webSearchStillConnecting'))
  }
  return result
}
