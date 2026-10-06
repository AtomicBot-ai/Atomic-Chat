/**
 * Tauri Model Setup Service — desktop implementation.
 *
 * A thin wrapper over the core's compatibility and model setup routes,
 * reached through the Rust relay (`atomic_core_call`). A failure rejects with
 * the relay's plain `{code, message, details?}` object, untouched. Records
 * arrive as the relayed `atomic-core://model-setup:changed` event, the bytes
 * of each stage as the ordinary `atomic-core://download:progress`.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { createSafeUnlisten } from '@/lib/tauriEvent'

import { DefaultModelSetupService } from './default'
import type {
  CompatibilityVerdict,
  ModelCompatibilityRequest,
  ModelSetup,
  ModelSetupEvent,
  ModelSetupPlan,
  ModelSetupPlanRequest,
  ModelSetupStartRequest,
  PrismFamiliesResponse,
} from './types'

export const CHANGED_EVENT = 'atomic-core://model-setup:changed'
export const PROGRESS_EVENT = 'atomic-core://download:progress'
/** The relay's snapshot: a core generation attached. */
export const RESET_EVENT = 'atomic-core://snapshot'

type Method = 'GET' | 'POST'

function coreCall<T>(method: Method, path: string, body: unknown = null) {
  return invoke<T>('atomic_core_call', { method, path, body })
}

export class TauriModelSetupService extends DefaultModelSetupService {
  override isSupported(): boolean {
    return true
  }

  override async checkCompatibility(
    request: ModelCompatibilityRequest
  ): Promise<CompatibilityVerdict> {
    return coreCall<CompatibilityVerdict>(
      'POST',
      '/models/compatibility',
      request
    )
  }

  override async plan(request: ModelSetupPlanRequest): Promise<ModelSetupPlan> {
    return coreCall<ModelSetupPlan>('POST', '/models/setup-plan', request)
  }

  override async families(): Promise<PrismFamiliesResponse> {
    return coreCall<PrismFamiliesResponse>(
      'GET',
      '/models/atomic-prism/families'
    )
  }

  override async start(request: ModelSetupStartRequest): Promise<ModelSetup> {
    return coreCall<ModelSetup>('POST', '/model-setups', request)
  }

  override async list(): Promise<ModelSetup[]> {
    const { setups } = await coreCall<{ setups: ModelSetup[] }>(
      'GET',
      '/model-setups'
    )
    return setups
  }

  override async cancel(setupId: string): Promise<ModelSetup> {
    return coreCall<ModelSetup>(
      'POST',
      `/model-setups/${encodeURIComponent(setupId)}/cancel`
    )
  }

  override async resume(setupId: string): Promise<ModelSetup> {
    return coreCall<ModelSetup>(
      'POST',
      `/model-setups/${encodeURIComponent(setupId)}/resume`
    )
  }

  override subscribe(handler: (event: ModelSetupEvent) => void): () => void {
    const pending: Promise<UnlistenFn>[] = [
      listen<ModelSetup>(CHANGED_EVENT, (event) =>
        handler({ type: 'changed', setup: event.payload })
      ),
      listen<{ taskId?: string; transferred?: number; total?: number }>(
        PROGRESS_EVENT,
        (event) => {
          const { taskId, transferred, total } = event.payload ?? {}
          if (!taskId) return
          handler({
            type: 'progress',
            taskId,
            transferred: transferred ?? 0,
            total: total ?? 0,
          })
        }
      ),
      listen(RESET_EVENT, () => handler({ type: 'reset' })),
    ]

    let detached = false
    return () => {
      // A second call (StrictMode, two consumers) must not unlisten the same
      // handler twice: that is what raises Tauri's `handlerId` TypeError.
      if (detached) return
      detached = true
      for (const promise of pending.splice(0)) {
        promise
          .then((unlisten) => createSafeUnlisten(unlisten)())
          .catch(() => {})
      }
    }
  }
}
