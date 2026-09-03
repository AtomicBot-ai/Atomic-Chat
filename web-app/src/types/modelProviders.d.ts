/**
 * The controller props for settings
 */
type ControllerProps = {
  value?: string | boolean | number
  placeholder?: string
  type?: string
  options?: Array<{ value: number | string; name: string }>
  input_actions?: string[]
  recommended?: string
}

/**
 * The setting item for a provider
 */
type ProviderSetting = {
  key: string
  title: string
  description: string
  controller_type: 'input' | 'checkbox' | 'dropdown' | 'slider' | string
  controller_props: ControllerProps
}

/**
 * The model object structure
 */
type Model = {
  id: string
  model?: string
  name?: string
  displayName?: string
  version?: number | string
  description?: string
  format?: string
  capabilities?: string[]
  /**
   * Reasoning knobs the model's chat template understands, detected from that
   * template by the local backend extensions. Absent for remote providers.
   */
  reasoning?: import('@janhq/core').ReasoningControls
  settings?: Record<string, ProviderSetting>
  /** Whether this model is an embedding model (e.g., BERT-based) */
  embedding?: boolean
  // Origin of a model imported from another app's storage, shown as a UI badge.
  source?:
    | 'ollama'
    | 'lmstudio'
    | 'unsloth'
    | 'local'
    | 'huggingface-cache'
  // Runtime-computed: weights file (or Ollama symlink target) is gone — a "broken link".
  missing?: boolean
  // Resolved absolute weights path; used to dedupe scan candidates vs imported models.
  path?: string
}

/**
 * The provider object structure
 */
type ProviderObject = {
  active: boolean
  provider: string
  explore_models_url?: string
  api_key?: string
  base_url?: string
  settings: ProviderSetting[]
  models: Model[]
  persist?: boolean
  custom_header?: ProviderCustomHeader[] | null
  /**
   * Registry-driven flag controlling whether the Settings → Providers Refresh
   * button probes the provider's live `/v1/models` endpoint. Defaults to
   * `true` (or when absent). Set to `false` in the atomic-chat-conf registry
   * for providers whose live listing is noisy/unusable, so only the curated
   * registry model list is shown. (ATO P2)
   */
  supports_model_listing?: boolean
}

/**
 * The model provider type
 */
type ModelProvider = ProviderObject

/**
 * Proxy configuration options
 * @description This type defines the structure of the proxy configuration options.
 */
type ProxyOptions = {
  proxyEnabled: boolean
  proxyUrl: string
  proxyUsername: string
  proxyPassword: string
  proxyIgnoreSSL: boolean
  verifyProxySSL: boolean
  verifyProxyHostSSL: boolean
  verifyPeerSSL: boolean
  verifyHostSSL: boolean
  noProxy: string
}

type ProviderCustomHeader = {
  header: string
  value: string
}