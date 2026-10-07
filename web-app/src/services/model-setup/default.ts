/**
 * Default Model Setup Service — the no-op used on web and mobile, where there
 * is no core to set a model up. `isSupported()` is false so the Hub downloads
 * the way it always did, and every call rejects in case something reaches it.
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

import type {
  CompatibilityVerdict,
  ModelCompatibilityRequest,
  ModelSetup,
  ModelSetupEvent,
  ModelSetupPlan,
  ModelSetupPlanRequest,
  ModelSetupService,
  ModelSetupStartRequest,
  PrismFamiliesResponse,
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

  async plan(_request: ModelSetupPlanRequest): Promise<ModelSetupPlan> {
    throw new Error(MODEL_SETUP_UNSUPPORTED)
  }

  async families(): Promise<PrismFamiliesResponse> {
    throw new Error(MODEL_SETUP_UNSUPPORTED)
  }

  async start(_request: ModelSetupStartRequest): Promise<ModelSetup> {
    throw new Error(MODEL_SETUP_UNSUPPORTED)
  }

  async list(): Promise<ModelSetup[]> {
    throw new Error(MODEL_SETUP_UNSUPPORTED)
  }

  async cancel(_setupId: string): Promise<ModelSetup> {
    throw new Error(MODEL_SETUP_UNSUPPORTED)
  }

  async resume(_setupId: string): Promise<ModelSetup> {
    throw new Error(MODEL_SETUP_UNSUPPORTED)
  }

  subscribe(_handler: (event: ModelSetupEvent) => void): () => void {
    return () => {}
  }
}
