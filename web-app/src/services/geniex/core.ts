/**
 * The core's GenieX routes the app calls, through the Rust relay (`atomic_core_call`): the devices
 * the SDK's library found on this Snapdragon X laptop, the prepare step that has nothing to do, and
 * the verdict on a variant before it downloads or on a model after it did.
 *
 * A failure rejects with the relay's `{code, message}`.
 */

import { invoke } from '@tauri-apps/api/core'

import type {
  GeniexAccelerators,
  GeniexCheckRequest,
  GeniexCheckResult,
  GeniexPrepareResult,
} from './types'

const call = <T>(method: 'GET' | 'POST', path: string, body: unknown = null) =>
  invoke<T>('atomic_core_call', { method, path, body })

/** The devices the active build's library found (NPU, GPU), and this computer's chip. Reads only. */
export function geniexAccelerators(): Promise<GeniexAccelerators> {
  return call('GET', '/runtimes/geniex/accelerators')
}

/** Nothing to download: the core answers `prepared` for every device it found, with why otherwise. */
export function prepareGeniexAccelerators(names: string[] = []): Promise<GeniexPrepareResult> {
  return call(
    'POST',
    '/runtimes/geniex/accelerators/prepare',
    names.length > 0 ? { accelerators: names } : {}
  )
}

/** Whether a variant or a downloaded model runs here; a model's answer carries its facts. */
export function checkGeniexModel(request: GeniexCheckRequest): Promise<GeniexCheckResult> {
  return call('POST', '/models/geniex/check', request)
}
