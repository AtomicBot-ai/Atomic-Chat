/**
 * Default Model Setup Service — the no-op used on web and mobile, where there
 * is no core to ask. `isSupported()` is false so the Hub downloads the way it
 * always did, and every call rejects in case something reaches it.
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

import type {
  CompatibilityVerdict,
  ModelCompatibilityRequest,
  ModelSetupService,
  PrismCatalog,
  PrismCatalogRequest,
  PrismFamiliesResponse,
  PrismPack,
} from './types'

export const MODEL_SETUP_UNSUPPORTED =
  'Model setup is not available on this platform.'

export class DefaultModelSetupService implements ModelSetupService {
  isSupported(): boolean {
    return false
  }

  async checkCompatibility(
    _request: ModelCompatibilityRequest
  ): Promise<CompatibilityVerdict> {
    throw new Error(MODEL_SETUP_UNSUPPORTED)
  }

  async families(): Promise<PrismFamiliesResponse> {
    throw new Error(MODEL_SETUP_UNSUPPORTED)
  }

  async prismCatalog(_request?: PrismCatalogRequest): Promise<PrismCatalog> {
    throw new Error(MODEL_SETUP_UNSUPPORTED)
  }

  async diskAvailable(): Promise<number | null> {
    throw new Error(MODEL_SETUP_UNSUPPORTED)
  }

  async installPrismBuild(_pack: PrismPack, _taskId: string): Promise<void> {
    throw new Error(MODEL_SETUP_UNSUPPORTED)
  }

  async activatePrismBuild(_pack: PrismPack): Promise<void> {
    throw new Error(MODEL_SETUP_UNSUPPORTED)
  }

  onCoreReset(_handler: () => void): () => void {
    return () => {}
  }
}
