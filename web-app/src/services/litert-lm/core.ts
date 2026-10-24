/**
 * The core's LiteRT-LM routes the app calls, through the Rust relay
 * (`atomic_core_call`): the OpenVINO accelerator an Intel NPU variant needs,
 * the prepare step, and the verdict on a variant before it downloads or on a
 * file after it did.
 *
 * `prepare` downloads inside the request (about 85 MB): progress comes as
 * `litert-lm:accelerators` events, and the answer is the summary. A failure
 * rejects with the relay's `{code, message}`.
 */

import { invoke } from '@tauri-apps/api/core'

import type {
  LiteRtLmAccelerators,
  LiteRtLmCheckRequest,
  LiteRtLmCheckResult,
  LiteRtLmPrepareResult,
} from './types'

const call = <T>(method: 'GET' | 'POST', path: string, body: unknown = null) =>
  invoke<T>('atomic_core_call', { method, path, body })

/** What this machine is offered (OpenVINO on an Intel NPU LiteRT-LM targets), with what is prepared. */
export function liteRtLmAccelerators(): Promise<LiteRtLmAccelerators> {
  return call('GET', '/runtimes/litert-lm/accelerators')
}

/**
 * Download, check and unpack `names` (every accelerator offered here when
 * empty). `ENGINE_INSTALL_IN_PROGRESS` while another prepare runs.
 */
export function prepareLiteRtLmAccelerators(
  names: string[] = []
): Promise<LiteRtLmPrepareResult> {
  return call(
    'POST',
    '/runtimes/litert-lm/accelerators/prepare',
    names.length > 0 ? { accelerators: names } : {}
  )
}

/** Whether a variant or a downloaded file runs here; a file's answer carries its metadata. */
export function checkLiteRtLmModel(
  request: LiteRtLmCheckRequest
): Promise<LiteRtLmCheckResult> {
  return call('POST', '/models/litert-lm/check', request)
}
