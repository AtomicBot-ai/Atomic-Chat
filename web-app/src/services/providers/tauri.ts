/**
 * Tauri Providers Service - Desktop implementation
 */

import { ensureRegistryLoaded } from '@/stores/provider-registry-store'
import { providerModels } from '@/constants/models'
import { EngineManager, SettingComponentProps } from '@janhq/core'
import { ModelCapabilities } from '@/types/models'
import { modelSettings } from '@/lib/predefined'
import { ExtensionManager } from '@/lib/extension'
import { fetch as fetchTauri } from '@tauri-apps/plugin-http'
import { invoke } from '@tauri-apps/api/core'
import { DefaultProvidersService } from './default'
import { getModelCapabilities } from '@/lib/models'

/**
 * Turn a raw `get_local_http` failure (e.g. `HTTP 404: 404 page not found`,
 * `Request failed: …`) into a concrete, user-readable reason. Mirrors the
 * status handling on the remote (Tauri-plugin) path so both surface the same
 * kinds of messages to the UI.
 */
function classifyLocalFetchError(
  label: string,
  baseUrl: string,
  triedUrls: string[],
  rawMsg: string
): string {
  if (rawMsg.startsWith('HTTP 401')) {
    return `Authentication failed: an API key is required or invalid for ${label}.`
  }
  if (rawMsg.startsWith('HTTP 403')) {
    return `Access forbidden: check your API key permissions for ${label}.`
  }
  if (rawMsg.startsWith('HTTP 404')) {
    return (
      `Models endpoint not found for ${label}. Tried: ${triedUrls.join(' and ')}. ` +
      `Check the Base URL — most OpenAI-compatible servers expose models at /v1/models.`
    )
  }
  // reqwest network/transport failures surface as "Request failed: …" or
  // "Body read failed: …" from the Rust get_local_http command.
  if (
    rawMsg.startsWith('Request failed') ||
    rawMsg.startsWith('Body read failed')
  ) {
    return (
      `Cannot connect to ${label} at ${baseUrl}. ` +
      `Check that the server is running and the address is correct.`
    )
  }
  return `Cannot fetch models from ${label} at ${baseUrl}: ${rawMsg}`
}

/**
 * Extract model ids from the parsed body of a `/models` endpoint. Handles the
 * OpenAI shape (`{ data: [{ id }] }`), a bare array, and `{ models: [...] }`.
 */
function extractModelIds(rawText: string, providerLabel: string): string[] {
  let data: unknown
  try {
    data = JSON.parse(rawText) as unknown
  } catch (err) {
    throw new Error(
      `Failed to parse JSON response from ${providerLabel}: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  const obj =
    data && typeof data === 'object'
      ? (data as Record<string, unknown>)
      : null

  const idOf = (model: unknown): string =>
    typeof model === 'string'
      ? model
      : model && typeof model === 'object' && 'id' in model
        ? String((model as { id?: unknown }).id ?? '')
        : ''

  let ids: string[]
  if (obj && Array.isArray(obj.data)) {
    // OpenAI shape: { data: [{ id }] }
    ids = (obj.data as unknown[]).map(idOf).filter(Boolean)
  } else if (Array.isArray(data)) {
    // Bare array: ["id", …] or [{ id }, …]
    ids = data.map(idOf).filter(Boolean)
  } else if (obj && Array.isArray(obj.models)) {
    // Alternative shape: { models: [...] }
    ids = (obj.models as unknown[]).map(idOf).filter(Boolean)
  } else {
    console.warn('Unexpected response format from provider API:', data)
    return []
  }

  // Some aggregators (e.g. AIML API) list the same model id more than once —
  // dedupe so the UI doesn't show identical rows. Preserve first-seen order.
  return Array.from(new Set(ids))
}

export class TauriProvidersService extends DefaultProvidersService {
  fetch(): typeof fetch {
    // Tauri implementation uses Tauri's fetch to avoid CORS issues
    return fetchTauri as typeof fetch
  }

  async getProviders(): Promise<ModelProvider[]> {
    try {
      const registryProviders = await ensureRegistryLoaded()
      const builtinProviders = registryProviders
        .map((provider) => {
          let models = (provider.models ?? []) as Model[]

          // Registry is the canonical source for the cloud catalog. We only
          // synthesize models from the in-code `providerModels` lookup when the
          // registry hasn't supplied any (back-compat for older manifests).
          if (
            models.length === 0 &&
            Object.keys(providerModels).includes(provider.provider)
          ) {
            const builtInModels = providerModels[
              provider.provider as unknown as keyof typeof providerModels
            ].models as unknown as string[]

            if (Array.isArray(builtInModels)) {
              models = builtInModels.map(
                (model) =>
                  ({
                    id: model,
                    name: model,
                    capabilities: getModelCapabilities(provider.provider, model),
                  }) as Model
              )
            }
          }

          return {
            ...provider,
            models,
          }
        })
        .filter(Boolean)

      const runtimeProviders: ModelProvider[] = []
      for (const [providerName, value] of EngineManager.instance().engines) {
        const models = await value.list() ?? [] 
        const provider: ModelProvider = {
          active: false,
          persist: true,
          provider: providerName,
          base_url:
            'inferenceUrl' in value
              ? (value.inferenceUrl as string).replace('/chat/completions', '')
              : '',
          settings: (await value.getSettings()).map((setting) => {
            return {
              key: setting.key,
              title: setting.title,
              description: setting.description,
              controller_type: setting.controllerType as unknown,
              controller_props: setting.controllerProps as unknown,
            }
          }) as ProviderSetting[],
          models: await Promise.all(
            models.map(async (model) => {
              let capabilities: string[] = []

              if ('capabilities' in model && Array.isArray(model.capabilities)) {
                capabilities = [...(model.capabilities as string[])]
              }
              if (!capabilities.includes(ModelCapabilities.TOOLS)) {
                try {
                  const toolSupported = await value.isToolSupported(model.id)
                  if (toolSupported) {
                    capabilities.push(ModelCapabilities.TOOLS)
                  }
                } catch (error) {
                  console.warn(
                    `Failed to check tool support for model ${model.id}:`,
                    error
                  )
                  // Continue without tool capabilities if check fails
                }
              }

              // Add embeddings capability for embedding models
              if (model.embedding && !capabilities.includes(ModelCapabilities.EMBEDDINGS)) {
                capabilities = [...capabilities, ModelCapabilities.EMBEDDINGS]
              }

              return {
                id: model.id,
                model: model.id,
                name: model.name,
                description: model.description,
                capabilities,
                embedding: model.embedding, // Preserve embedding flag for filtering in UI
                // Origin of an imported model, for the UI badge.
                source: (model as { source?: Model['source'] }).source,
                // Broken-link flag: keep out of auto-start, flag in the UI.
                missing: (model as { missing?: boolean }).missing,
                // Absolute weights path, for deduping scan candidates.
                path: (model as { path?: string }).path,
                provider: providerName,
                settings: Object.values(modelSettings).reduce(
                  (acc, setting) => {
                    let value = setting.controller_props.value
                    if (setting.key === 'ctx_len') {
                      value = 16384 // Default context length for Llama.cpp models
                    }
                    acc[setting.key] = {
                      ...setting,
                      controller_props: {
                        ...setting.controller_props,
                        value: value,
                      },
                    }
                    return acc
                  },
                  {} as Record<string, ProviderSetting>
                ),
              } as Model
            })
          ),
        }
        runtimeProviders.push(provider)
      }

      return runtimeProviders.concat(builtinProviders as ModelProvider[])
    } catch (error: unknown) {
      console.error('Error getting providers in Tauri:', error)
      return []
    }
  }

  async fetchModelsFromProvider(provider: ModelProvider): Promise<string[]> {
    if (!provider.base_url) {
      throw new Error('Provider must have base_url configured')
    }

    // Normalise: trim surrounding whitespace (a stray trailing space, e.g.
    // from a paste, otherwise leaks into the path as `/v1 /models` → 404) and
    // strip trailing slashes for consistent URL construction.
    const baseUrl = provider.base_url.trim().replace(/\/+$/, '')
    const hasApiKey = Boolean(provider.api_key)

    // Build the primary URL and, when the base_url does not already contain a
    // /v1 path segment, a fallback URL to try automatically on 404. Most
    // OpenAI-compatible servers (vLLM, llama.cpp, Ollama, …) expose models at
    // /v1/models, but users commonly type the bare host without the prefix —
    // and some serve a bare /models. Trying /models first then /v1/models on a
    // 404 covers both shapes without breaking already-prefixed URLs (ATO-211).
    const primaryUrl = `${baseUrl}/models`
    const hasV1Segment = /\/v1(\/|$)/.test(baseUrl)
    const fallbackUrl = hasV1Segment ? null : `${baseUrl}/v1/models`

    // The Tauri HTTP plugin runs requests through the Rust IPC layer, which
    // means they DO NOT appear in the WebView Network tab. Surface them via
    // explicit console logs so the user can see something is happening.
    console.info(
      `[providers:${provider.provider}] GET ${primaryUrl} (api_key=${hasApiKey ? 'present' : 'missing'})${fallbackUrl ? ` (fallback: ${fallbackUrl})` : ''}`
    )

    // Build request headers once; shared across primary and fallback attempts.
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    // Add Origin header for local providers to avoid CORS issues
    // Some local providers (like Ollama) require an Origin header
    if (
      provider.base_url.includes('localhost:') ||
      provider.base_url.includes('127.0.0.1:')
    ) {
      headers['Origin'] = 'tauri://localhost'
    }

    // Only add authentication headers if API key is provided
    if (provider.api_key) {
      headers['x-api-key'] = provider.api_key
      headers['Authorization'] = `Bearer ${provider.api_key}`
    }

    if (provider.custom_header) {
      provider.custom_header.forEach((header) => {
        headers[header.header] = header.value
      })
    }

    // All providers — cloud, self-hosted (vLLM/llama.cpp on a LAN host), and
    // loopback (Ollama/LM Studio) — go through the Rust `reqwest` command
    // rather than the Tauri HTTP plugin. The plugin's webview body-streaming
    // has been observed to hang reading the response for many providers
    // (GitHub #90 Home-Lab: "Reading response body timed out after 15s" on a
    // perfectly healthy server). Doing the GET server-side also sidesteps CORS.
    const urls = fallbackUrl ? [primaryUrl, fallbackUrl] : [primaryUrl]
    const MAX_ATTEMPTS = 3
    let lastError: unknown

    for (const url of urls) {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const rawText = await invoke<string>('get_local_http', {
            url,
            headers,
            timeoutSecs: 30,
          })
          const ids = extractModelIds(rawText, provider.provider)
          console.info(
            `[providers:${provider.provider}] parsed ${ids.length} model ids (url=${url}, attempt=${attempt})`
          )
          return ids
        } catch (err) {
          lastError = err
          const msg = err instanceof Error ? err.message : String(err)
          console.warn(
            `[providers:${provider.provider}] get_local_http ${url} failed (attempt ${attempt}): ${msg}`
          )

          // HTTP status errors (404/401/403/5xx) are deterministic — retrying
          // the same URL won't help, so stop the retry loop.
          if (msg.startsWith('HTTP ')) break
          // Transport errors (connection reset, stale pooled socket, body
          // read) are worth a quick retry with a fresh request.
          if (attempt < MAX_ATTEMPTS) {
            await new Promise((r) => setTimeout(r, 300 * attempt))
          }
        }
      }

      // Fall through to the next URL only on a 404 (wrong path → try the
      // /v1/models fallback). Any other failure stops here.
      const lastMsg =
        lastError instanceof Error ? lastError.message : String(lastError)
      if (!lastMsg.startsWith('HTTP 404')) break
    }

    const msg =
      lastError instanceof Error ? lastError.message : String(lastError)
    throw new Error(
      classifyLocalFetchError(provider.provider, baseUrl, urls, msg)
    )
  }

  async updateSettings(
    providerName: string,
    settings: ProviderSetting[]
  ): Promise<void> {
    try {
      return ExtensionManager.getInstance()
        .getEngine(providerName)
        ?.updateSettings(
          settings.map((setting) => ({
            ...setting,
            controllerProps: {
              ...setting.controller_props,
              value:
                setting.controller_props.value !== undefined
                  ? setting.controller_props.value
                  : '',
            },
            controllerType: setting.controller_type,
          })) as SettingComponentProps[]
        )
    } catch (error) {
      console.error('Error updating settings in Tauri:', error)
      throw error
    }
  }
}
