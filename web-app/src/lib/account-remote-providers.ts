/**
 * The providers remote access makes: one per computer of the account this
 * device is connected to, named "<computer> (remote)". Rust tells which
 * connections are ready (`account-remote-connections`); this keeps
 * `useModelProvider` in step: adds, follows a new address or key, refreshes
 * the model list (also when the host sends a newer address list, or when
 * the person asks), and removes the provider once the access ends.
 *
 * A managed provider carries `account_remote.host_id`; the Endpoints page
 * shows it read-only (`isAccountManagedProvider`).
 */

import { cloneDeep } from 'lodash'

import { openAIProviderSettings } from '@/constants/providers'
import { useModelProvider } from '@/hooks/useModelProvider'
import { getModelCapabilities } from '@/lib/models'
import { buildBaseUrlUpdate } from '@/lib/provider-base-url'
import { buildApiKeyUpdate } from '@/lib/provider-api-key'
import type { ServiceHub } from '@/services'
import type { RemoteProviderConnection } from '@/services/account/remote-types'
import {
  registerRemoteProvider,
  unregisterRemoteProvider,
} from '@/utils/registerRemoteProvider'

export const REMOTE_PROVIDER_SUFFIX = ' (remote)'

export function isAccountManagedProvider(
  provider: Pick<ProviderObject, 'account_remote'> | undefined
): boolean {
  return Boolean(provider?.account_remote?.host_id)
}

/** "Studio Mac (remote)", or "Studio Mac (remote) 2" when the name is taken. */
export function managedProviderName(
  hostName: string,
  taken: Iterable<string>
): string {
  const used = new Set(Array.from(taken, (name) => name.toLowerCase()))
  const base = `${hostName.trim() || 'Computer'}${REMOTE_PROVIDER_SUFFIX}`
  let name = base
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} ${n}`
  return name
}

type Deps = Pick<ServiceHub, 'providers'>

export interface SyncOptions {
  /** List every live provider's models again, even when nothing changed. */
  refreshModels?: boolean
}

/** The address list number each host was last synced with. Memory only. */
const syncedSeq = new Map<string, number>()

async function refreshModels(name: string, hub: Deps): Promise<void> {
  const current = useModelProvider.getState().getProviderByName(name)
  if (!current) return
  try {
    const ids = await hub.providers().fetchModelsFromProvider(current)
    const models = Array.from(new Set(ids)).map((id) => ({
      id,
      model: id,
      name: id,
      capabilities: getModelCapabilities(name, id),
      version: '1.0',
    }))
    useModelProvider.getState().updateProvider(name, { models })
  } catch (error) {
    // The host may be asleep; its models come with its next address list.
    console.warn(`[remote] could not list the models of ${name}:`, error)
  }
}

async function register(name: string): Promise<void> {
  const provider = useModelProvider.getState().getProviderByName(name)
  if (!provider) return
  try {
    await registerRemoteProvider(provider)
  } catch (error) {
    console.warn(`[remote] could not register ${name}:`, error)
  }
}

async function syncOnce(
  connections: RemoteProviderConnection[],
  hub: Deps,
  options: SyncOptions
): Promise<void> {
  const store = () => useModelProvider.getState()

  for (const connection of connections) {
    const existing = store().providers.find(
      (p) => p.account_remote?.host_id === connection.hostId
    )
    let name: string
    let changed = false
    if (!existing) {
      name = managedProviderName(
        connection.hostName,
        store().providers.map((p) => p.provider)
      )
      const settings = (
        cloneDeep(openAIProviderSettings) as ProviderSetting[]
      ).map((setting) =>
        setting.key === 'base-url'
          ? {
              ...setting,
              controller_props: {
                ...setting.controller_props,
                value: connection.baseUrl,
              },
            }
          : setting
      )
      store().addProvider({
        provider: name,
        active: true,
        models: [],
        settings,
        api_key: '',
        base_url: connection.baseUrl,
        account_remote: { host_id: connection.hostId },
      })
      const added = store().getProviderByName(name)
      if (added)
        store().updateProvider(
          name,
          buildApiKeyUpdate(added, connection.apiKey)
        )
      changed = true
    } else {
      name = existing.provider
      if ((existing.base_url ?? '') !== connection.baseUrl) {
        store().updateProvider(
          name,
          buildBaseUrlUpdate(existing, connection.baseUrl)
        )
        changed = true
      }
      const current = store().getProviderByName(name)
      if (current && (current.api_key ?? '') !== connection.apiKey) {
        store().updateProvider(
          name,
          buildApiKeyUpdate(current, connection.apiKey)
        )
        changed = true
      }
      if ((current?.models.length ?? 0) === 0) changed = true
      // A newer address list: the host may serve other models now.
      const seen = syncedSeq.get(connection.hostId)
      if (seen !== undefined && connection.endpointsSeq > seen) changed = true
      if (options.refreshModels) changed = true
    }
    syncedSeq.set(connection.hostId, connection.endpointsSeq)
    if (!changed) continue
    // Registered first, so the proxy knows the address; then again with the
    // model ids it routes by.
    await register(name)
    await refreshModels(name, hub)
    await register(name)
  }

  const live = new Set(connections.map((c) => c.hostId))
  for (const hostId of Array.from(syncedSeq.keys()))
    if (!live.has(hostId)) syncedSeq.delete(hostId)
  const stale = store().providers.filter(
    (p) => p.account_remote?.host_id && !live.has(p.account_remote.host_id)
  )
  for (const provider of stale) {
    await unregisterRemoteProvider(provider.provider)
    store().deleteProvider(provider.provider)
  }
}

let queue: Promise<void> = Promise.resolve()

/** One sync at a time, in the order the lists arrived. */
export function syncAccountRemoteProviders(
  connections: RemoteProviderConnection[],
  hub: Deps,
  options: SyncOptions = {}
): Promise<void> {
  queue = queue.catch(() => {}).then(() => syncOnce(connections, hub, options))
  return queue
}
