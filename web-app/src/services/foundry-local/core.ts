/**
 * The core's Foundry Local routes the app calls, through the Rust relay
 * (`atomic_core_call`): the accelerators of the active build, the prepare step
 * the person orders, and the verdict on a variant before it downloads.
 *
 * `prepare` downloads inside the request (the CUDA accelerator is 2 GB on
 * Windows): progress comes as `foundry-local:accelerators` events, and the
 * answer is the summary. A failure rejects with the relay's `{code, message}`.
 */

import { invoke } from '@tauri-apps/api/core'

import type {
  FoundryLocalAccelerators,
  FoundryLocalCheckRequest,
  FoundryLocalCheckResult,
  FoundryLocalPrepareResult,
} from './types'

const call = <T>(method: 'GET' | 'POST', path: string, body: unknown = null) =>
  invoke<T>('atomic_core_call', { method, path, body })

/** The last probe of the active build; `force` probes again. Never downloads. */
export function foundryLocalAccelerators(
  options: { force?: boolean } = {}
): Promise<FoundryLocalAccelerators> {
  return call(
    'GET',
    `/runtimes/foundry-local/accelerators${options.force ? '?force=1' : ''}`
  )
}

/**
 * Download and register `names` (every accelerator the library offers here
 * when empty). `ENGINE_INSTALL_IN_PROGRESS` while another prepare runs.
 */
export function prepareFoundryLocalAccelerators(
  names: string[] = []
): Promise<FoundryLocalPrepareResult> {
  return call(
    'POST',
    '/runtimes/foundry-local/accelerators/prepare',
    names.length > 0 ? { accelerators: names } : {}
  )
}

/** Whether a variant would run on this machine, by its accelerator and device. */
export function checkFoundryLocalVariant(
  request: FoundryLocalCheckRequest
): Promise<FoundryLocalCheckResult> {
  return call('POST', '/models/foundry-local/check', request)
}
