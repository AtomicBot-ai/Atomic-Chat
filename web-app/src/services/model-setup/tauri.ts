/**
 * Tauri Model Setup Service — desktop implementation.
 *
 * A thin wrapper over the core routes a Bonsai download reads and drives —
 * compatibility, the Bonsai families, the PrismML catalog and install, the
 * engine activation and the free disk space — reached through the Rust relay
 * (`atomic_core_call`). A failure rejects with the relay's plain
 * `{code, message, details?}` object, untouched.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

import { PRISM_PROVIDER } from '@/lib/model-setup'
import { createSafeUnlisten } from '@/lib/tauriEvent'
import { engineBuildProxy } from '@/services/engine-builds/core'
import { activateEngineBuildThroughCore } from '@/services/engines/update'

import { DefaultModelSetupService } from './default'
import type {
  CompatibilityVerdict,
  ModelCompatibilityRequest,
  PrismCatalog,
  PrismFamiliesResponse,
  PrismPack,
} from './types'

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

  override async families(): Promise<PrismFamiliesResponse> {
    return coreCall<PrismFamiliesResponse>(
      'GET',
      '/models/atomic-prism/families'
    )
  }

  override async prismCatalog(): Promise<PrismCatalog> {
    return coreCall<PrismCatalog>(
      'POST',
      `/backends/${PRISM_PROVIDER}/catalog`,
      { app_version: VERSION, proxy: engineBuildProxy() ?? null }
    )
  }

  override async diskAvailable(): Promise<number | null> {
    const { bytes } = await coreCall<{ bytes: number | null }>(
      'POST',
      '/disk/available',
      {}
    )
    return bytes
  }

  override async installPrismBuild(
    pack: PrismPack,
    taskId: string
  ): Promise<void> {
    await coreCall('POST', `/backends/${PRISM_PROVIDER}/install`, {
      version: pack.version,
      backend: pack.backend,
      task_id: taskId,
      proxy: engineBuildProxy() ?? null,
    })
  }

  override async activatePrismBuild(pack: PrismPack): Promise<void> {
    await activateEngineBuildThroughCore(
      PRISM_PROVIDER,
      pack.version,
      pack.backend
    )
  }

  override onCoreReset(handler: () => void): () => void {
    const pending = listen(RESET_EVENT, () => handler())
    let detached = false
    return () => {
      // A second call (StrictMode, two consumers) must not unlisten the same
      // handler twice: that is what raises Tauri's `handlerId` TypeError.
      if (detached) return
      detached = true
      pending.then((unlisten) => createSafeUnlisten(unlisten)()).catch(() => {})
    }
  }
}
