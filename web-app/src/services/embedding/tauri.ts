/**
 * Tauri Embedding Service — desktop implementation.
 *
 * A thin wrapper over the core's `/atomic/v1/embedding/*` routes, reached
 * through the Rust relay (`atomic_core_call`). A failure rejects with the
 * relay's plain `{code, message, details?}` object, untouched. Events arrive
 * as the relayed `atomic-core://embedding:*` events.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { createSafeUnlisten } from '@/lib/tauriEvent'

import { DefaultEmbeddingService } from './default'
import type {
  EmbeddingConfig,
  EmbeddingConfigAnswer,
  EmbeddingCoreError,
  EmbeddingEmbedResponse,
  EmbeddingEvent,
  EmbeddingStatus,
} from './types'

/** The core's control-route prefix for the embedding model. */
export const EMBEDDING_PREFIX = '/embedding'

export const STATE_EVENT = 'atomic-core://embedding:state'
export const ERROR_EVENT = 'atomic-core://embedding:error'
/** The relay's snapshot: a core generation attached. */
export const RESET_EVENT = 'atomic-core://snapshot'

type Method = 'GET' | 'POST' | 'PUT'

export function coreCall<T>(
  method: Method,
  path: string,
  body: unknown = null
): Promise<T> {
  return invoke<T>('atomic_core_call', {
    method,
    path: `${EMBEDDING_PREFIX}${path}`,
    body,
  })
}

export class TauriEmbeddingService extends DefaultEmbeddingService {
  override isSupported(): boolean {
    return true
  }

  override async getStatus(): Promise<EmbeddingStatus> {
    return coreCall<EmbeddingStatus>('GET', '/status')
  }

  override async getConfig(): Promise<EmbeddingConfigAnswer> {
    return coreCall<EmbeddingConfigAnswer>('GET', '/config')
  }

  override async setConfig(
    patch: Partial<EmbeddingConfig>
  ): Promise<EmbeddingConfigAnswer> {
    return coreCall<EmbeddingConfigAnswer>('PUT', '/config', patch)
  }

  override async load(): Promise<EmbeddingStatus> {
    return coreCall<EmbeddingStatus>('POST', '/load')
  }

  override async unload(): Promise<EmbeddingStatus> {
    return coreCall<EmbeddingStatus>('POST', '/unload')
  }

  override async embed(
    request: Record<string, unknown>
  ): Promise<EmbeddingEmbedResponse> {
    return coreCall<EmbeddingEmbedResponse>('POST', '/embed', request)
  }

  override subscribe(handler: (event: EmbeddingEvent) => void): () => void {
    const pending: Promise<UnlistenFn>[] = [
      listen<EmbeddingStatus>(STATE_EVENT, (event) =>
        handler({ type: 'state', status: event.payload })
      ),
      listen<EmbeddingCoreError>(ERROR_EVENT, (event) =>
        handler({ type: 'error', error: event.payload })
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
