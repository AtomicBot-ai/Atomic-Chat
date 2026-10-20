/**
 * Default Providers Service - Generic implementation with minimal returns
 */

import type { EndpointCheckResult, ProvidersService } from './types'

export class DefaultProvidersService implements ProvidersService {
  async getProviders(): Promise<ModelProvider[]> {
    return []
  }

  async fetchModelsFromProvider(provider: ModelProvider): Promise<string[]> {
    console.log('fetchModelsFromProvider called with provider:', provider)
    return []
  }

  async checkProviderEndpoint(
    provider: ModelProvider
  ): Promise<EndpointCheckResult> {
    // The check goes through a Rust command; there is none outside the app.
    void provider
    return {
      ok: false,
      latencyMs: 0,
      modelCount: 0,
      message: 'Endpoint checks run in the desktop app only.',
    }
  }

  async updateSettings(providerName: string, settings: ProviderSetting[]): Promise<void> {
    console.log('updateSettings called:', { providerName, settings })
    // No-op - not implemented in default service
  }

  fetch(): typeof fetch {
    return fetch
  }
}
