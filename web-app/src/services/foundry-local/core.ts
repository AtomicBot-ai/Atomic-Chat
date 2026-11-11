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

import { foundryRuntimeMeetsMinimum } from '@/lib/foundry-local/version'
import { engineVersions } from '@/services/engines/core'

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

/** Whether a variant would run on this machine, including the model's minimum runtime when known. */
export async function checkFoundryLocalVariant(
  request: FoundryLocalCheckRequest
): Promise<FoundryLocalCheckResult> {
  const path = '/models/foundry-local/check'
  const { min_runtime_version: minimum, ...legacyRequest } = request
  try {
    return await call('POST', path, request)
  } catch (error) {
    const refusal = error as { code?: unknown; message?: unknown } | null
    if (
      !minimum ||
      refusal?.code !== 'INVALID_ARGUMENT' ||
      refusal.message !== 'The request has fields this core does not know: min_runtime_version.'
    ) throw error
  }

  const legacy = await call<FoundryLocalCheckResult>('POST', path, legacyRequest)
  if (legacy.verdict === 'engine-not-installed' || legacy.verdict === 'platform-unsupported') return legacy

  const versions = await engineVersions().catch(() => null)
  const active = versions?.engines.find((entry) => entry.engine === 'foundry-local')?.active?.version
  const meetsMinimum = active ? foundryRuntimeMeetsMinimum(active, minimum) : null
  if (meetsMinimum === null) {
    throw new Error(`A newer Atomic Chat core is needed to verify the Foundry Local runtime requirement (${minimum} or newer).`)
  }
  if (meetsMinimum) return legacy
  return {
    ...legacy,
    verdict: 'engine-update-required',
    reason: `Foundry Local ${active?.replace(/^v/, '')} is active; this model requires ${minimum} or newer.`,
  }
}
