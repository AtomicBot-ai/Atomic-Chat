/**
 * Settings > Runtimes "Connect": turns a runtime the scan found into a model
 * provider, so its models appear in the model picker and are served through
 * Radium's own API.
 *
 * Nothing new is invented here. A connected runtime is an ordinary
 * OpenAI-compatible provider:
 * - `DataProvider` already registers every provider with the Local API
 *   Server proxy whenever the provider list changes.
 * - `isKeylessRemoteProvider` already lets a keyless loopback server through.
 * - `fetchModelsFromProvider` already reads `/v1/models`.
 *
 * Ollama and the user's own llama-server reuse their existing catalogue ids
 * (`ollama`, `llamacpp-server`), so connecting fills in the entry the Cloud
 * page already shows instead of adding a duplicate.
 */

import cloneDeep from 'lodash/cloneDeep'
import { openAIProviderSettings } from '@/constants/providers'
import { getModelCapabilities } from '@/lib/models'
import type { ServiceHub } from '@/services'
import type { RuntimeDescriptor, RuntimeDetection } from '@/services/runtimes'

/** Catalogue runtimes that keep a provider id the app already knows. */
const EXISTING_PROVIDER_IDS: Record<string, string> = {
  ollama: 'ollama',
  'llama-cpp': 'llamacpp-server',
}

/**
 * Image runtimes connect through the Media page, which already has adapters
 * for them, not through the chat providers.
 */
const MEDIA_RUNTIMES = new Set(['comfyui', 'invokeai', 'automatic1111', 'sd-webui-forge'])

export type ConnectTarget =
  | {
      kind: 'provider'
      /** The provider id the store and the proxy key on. */
      providerId: string
      /** The OpenAI base URL, ending in `/v1`. */
      baseUrl: string
    }
  | { kind: 'media' }

function portOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).port
  } catch {
    return ''
  }
}

/**
 * What connecting a detection means, or `null` when it cannot be connected:
 * a runtime with no OpenAI-compatible API (TGI speaks it, InvokeAI does not).
 */
export function connectTarget(
  detection: RuntimeDetection,
  byId: Map<string, RuntimeDescriptor>
): ConnectTarget | null {
  const runtime = detection.runtimeId ? byId.get(detection.runtimeId) : undefined
  if (runtime && MEDIA_RUNTIMES.has(runtime.id)) return { kind: 'media' }

  const baseUrl = `${detection.baseUrl.replace(/\/+$/, '')}/v1`
  if (!runtime) {
    // An unidentified server that answered `/v1/models` like OpenAI: it can
    // be used, under a name that says where it is rather than guessing.
    return {
      kind: 'provider',
      providerId: `Local server ${portOf(detection.baseUrl) || detection.baseUrl}`,
      baseUrl,
    }
  }
  if (!runtime.apis.includes('open_ai_compatible')) return null
  return {
    kind: 'provider',
    providerId: EXISTING_PROVIDER_IDS[runtime.id] ?? runtime.name,
    baseUrl,
  }
}

/** True when a provider with this id already points at this address. */
export function isConnected(
  target: ConnectTarget | null,
  providers: ModelProvider[]
): boolean {
  if (!target || target.kind !== 'provider') return false
  const provider = providers.find((p) => p.provider === target.providerId)
  return Boolean(
    provider &&
      provider.active &&
      normalize(provider.base_url) === normalize(target.baseUrl) &&
      provider.models.length > 0
  )
}

function normalize(url: string | undefined): string {
  return (url ?? '').trim().replace(/\/+$/, '').toLowerCase()
}

/** The OpenAI settings template with the base URL filled in. */
function settingsFor(baseUrl: string): ProviderSetting[] {
  const settings = cloneDeep(openAIProviderSettings) as ProviderSetting[]
  for (const setting of settings) {
    if (setting.key === 'base-url') {
      setting.controller_props = {
        ...setting.controller_props,
        value: baseUrl,
        placeholder: baseUrl,
      }
    }
    if (setting.key === 'api-key') {
      setting.description =
        'Optional. Only needed if this server was started with an API key.'
      setting.controller_props = {
        ...setting.controller_props,
        placeholder: 'Leave empty for an unauthenticated server',
      }
    }
  }
  return settings
}

export type ConnectDeps = {
  providers: ModelProvider[]
  addProvider: (provider: ModelProvider) => void
  updateProvider: (providerName: string, data: Partial<ModelProvider>) => void
  getProviderByName: (providerName: string) => ModelProvider | undefined
  serviceHub: Pick<ServiceHub, 'providers'>
}

export type ConnectResult = {
  providerId: string
  modelCount: number
  /** Set when the live model list could not be read and the scan's was used. */
  usedScanModels: boolean
}

/**
 * Creates or updates the provider for `target`, then fills its model list
 * from the server's own `/v1/models`. If that read fails, the models the scan
 * already saw are used, so a connection that works is never left empty.
 * Throws when neither yields a model: a provider with no models is not usable.
 */
export async function connectRuntime(
  target: Extract<ConnectTarget, { kind: 'provider' }>,
  scannedModels: string[],
  deps: ConnectDeps
): Promise<ConnectResult> {
  const { providerId, baseUrl } = target
  const existing = deps.providers.find((p) => p.provider === providerId)
  if (existing) {
    deps.updateProvider(providerId, {
      active: true,
      base_url: baseUrl,
      settings: existing.settings.map((setting) =>
        setting.key === 'base-url'
          ? { ...setting, controller_props: { ...setting.controller_props, value: baseUrl } }
          : setting
      ),
    })
  } else {
    deps.addProvider({
      provider: providerId,
      active: true,
      api_key: '',
      base_url: baseUrl,
      settings: settingsFor(baseUrl),
      models: [],
    })
  }

  const provider = deps.getProviderByName(providerId) ?? {
    provider: providerId,
    active: true,
    api_key: existing?.api_key ?? '',
    base_url: baseUrl,
    settings: settingsFor(baseUrl),
    models: [],
  }

  let ids: string[]
  let usedScanModels = false
  try {
    ids = await deps.serviceHub.providers().fetchModelsFromProvider(provider)
  } catch (error) {
    console.warn(`[runtimes] ${providerId}: /v1/models failed, using the scan's list`, error)
    ids = scannedModels
    usedScanModels = true
  }
  if (ids.length === 0 && !usedScanModels && scannedModels.length > 0) {
    ids = scannedModels
    usedScanModels = true
  }
  if (ids.length === 0) {
    throw new Error(
      `${providerId} answered but offers no models yet. Load or download a model in it, then connect again.`
    )
  }

  const current = deps.getProviderByName(providerId)?.models ?? existing?.models ?? []
  const byId = new Map<string, Model>()
  for (const model of current) if (model.id) byId.set(model.id, model)
  for (const id of ids) {
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        model: id,
        name: id,
        capabilities: getModelCapabilities(providerId, id),
        version: '1.0',
      })
    }
  }
  deps.updateProvider(providerId, { models: Array.from(byId.values()) })
  return { providerId, modelCount: ids.length, usedScanModels }
}
