/**
 * Default Media Service — the no-op used on web and mobile, where there is no core to generate
 * through. `isSupported()` is false, the catalog is empty, and a listing rejects.
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

import type { MediaCatalogView, MediaKind, MediaProviderModels, MediaService } from './types'

export const MEDIA_UNSUPPORTED = 'Cloud media models are not available on this platform.'

export class DefaultMediaService implements MediaService {
  isSupported(): boolean {
    return false
  }

  async catalog(): Promise<MediaCatalogView | null> {
    return null
  }

  async providerModels(_provider: string, _kind: MediaKind): Promise<MediaProviderModels> {
    throw new Error(MEDIA_UNSUPPORTED)
  }
}
