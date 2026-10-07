/**
 * Default Embedding Service — the no-op used on web and mobile, where there is
 * no core to run an embedding model. `isSupported()` is false so the UI never
 * offers the models, and every call rejects in case something reaches it
 * anyway.
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

import type {
  EmbeddingConfig,
  EmbeddingConfigAnswer,
  EmbeddingEmbedResponse,
  EmbeddingEvent,
  EmbeddingService,
  EmbeddingStatus,
} from './types'

export const EMBEDDING_UNSUPPORTED =
  'Embedding models are not available on this platform.'

export class DefaultEmbeddingService implements EmbeddingService {
  isSupported(): boolean {
    return false
  }

  async getStatus(): Promise<EmbeddingStatus> {
    throw new Error(EMBEDDING_UNSUPPORTED)
  }

  async getConfig(): Promise<EmbeddingConfigAnswer> {
    throw new Error(EMBEDDING_UNSUPPORTED)
  }

  async setConfig(
    _patch: Partial<EmbeddingConfig>
  ): Promise<EmbeddingConfigAnswer> {
    throw new Error(EMBEDDING_UNSUPPORTED)
  }

  async load(): Promise<EmbeddingStatus> {
    throw new Error(EMBEDDING_UNSUPPORTED)
  }

  async unload(): Promise<EmbeddingStatus> {
    throw new Error(EMBEDDING_UNSUPPORTED)
  }

  async embed(
    _request: Record<string, unknown>
  ): Promise<EmbeddingEmbedResponse> {
    throw new Error(EMBEDDING_UNSUPPORTED)
  }

  subscribe(_handler: (event: EmbeddingEvent) => void): () => void {
    return () => {}
  }
}
