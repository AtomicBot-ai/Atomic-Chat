/**
 * Tauri Media Service — the core's `/atomic/v1/media/*` routes through the Rust relay
 * (`atomic_core_call`). An older core has no such routes: its 404 (`HTTP_404`, or the core's
 * `NOT_FOUND`) and the 409 of a core built without remote media (`REMOTE_NOT_CONFIGURED`) both read
 * as "no catalog", so the app never offers remote models a core cannot run (it would otherwise
 * ignore `target` and run the resident model).
 */

import { invoke } from '@tauri-apps/api/core'

import { DefaultMediaService } from './default'
import type { MediaCatalogView, MediaKind, MediaProviderModels } from './types'

const ABSENT = new Set(['HTTP_404', 'NOT_FOUND', 'ROUTE_NOT_FOUND', 'REMOTE_NOT_CONFIGURED'])

/** Whether a relay rejection means the core has no remote media at all. */
export function isAbsentMedia(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && ABSENT.has(code)
}

export class TauriMediaService extends DefaultMediaService {
  override isSupported(): boolean {
    return true
  }

  override async catalog(): Promise<MediaCatalogView | null> {
    try {
      return await invoke<MediaCatalogView>('atomic_core_call', {
        method: 'GET',
        path: '/media/catalog',
        body: null,
      })
    } catch (error) {
      if (isAbsentMedia(error)) return null
      throw error
    }
  }

  override async providerModels(provider: string, kind: MediaKind): Promise<MediaProviderModels> {
    return invoke<MediaProviderModels>('atomic_core_call', {
      method: 'GET',
      path: `/media/providers/${encodeURIComponent(provider)}/models?kind=${kind}`,
      body: null,
    })
  }
}
