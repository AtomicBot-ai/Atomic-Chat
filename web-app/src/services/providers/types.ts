/**
 * Providers Service Types
 */

/** One check of a provider's endpoint: Custom Endpoint's "Ping". */
export type EndpointCheckResult = {
  ok: boolean
  /** Round trip of the request that answered, or of the attempt that failed. */
  latencyMs: number
  /** Models the endpoint listed; 0 when it did not answer with a list. */
  modelCount: number
  /** Why the check failed, readable as is. */
  message?: string
}

export interface ProvidersService {
  getProviders(): Promise<ModelProvider[]>
  fetchModelsFromProvider(provider: ModelProvider): Promise<string[]>
  checkProviderEndpoint(provider: ModelProvider): Promise<EndpointCheckResult>
  updateSettings(providerName: string, settings: ProviderSetting[]): Promise<void>
  fetch(): typeof fetch
}
