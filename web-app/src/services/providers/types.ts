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
  /** The HTTP status the endpoint failed with, when it answered with one. */
  httpStatus?: number
  /**
   * What the endpoint answered with that status, as sent (cut short): tells
   * an invalid key from a valid one without permission to list models.
   */
  responseBody?: string
}

export interface ProvidersService {
  getProviders(): Promise<ModelProvider[]>
  fetchModelsFromProvider(provider: ModelProvider): Promise<string[]>
  checkProviderEndpoint(provider: ModelProvider): Promise<EndpointCheckResult>
  /**
   * One GET of `url` with the provider's key and headers: its registry
   * `key_check`. Any 2xx is `ok`; `modelCount` is always 0.
   */
  checkProviderKeyUrl(
    provider: ModelProvider,
    url: string
  ): Promise<EndpointCheckResult>
  updateSettings(providerName: string, settings: ProviderSetting[]): Promise<void>
  fetch(): typeof fetch
}
