import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ATOMIC_MEDIA_WORKER_PROVIDER_ID,
  BASELINE_MEDIA_PROVIDERS,
  BUILTIN_ENGINE_PROVIDER_ID,
} from '@/constants/mediaProviders'
import { localStorageKey } from '@/constants/localStorage'
import type {
  MediaCapabilities,
  MediaProviderAdapter,
  MediaProviderDescriptor,
} from '@/services/media/contract'

vi.mock('@/services/media/providerFactory', () => ({
  createMediaAdapter: (descriptor: MediaProviderDescriptor) =>
    fakeAdapters[descriptor.id] ?? offlineAdapter(descriptor),
  UnknownMediaAdapterError: class extends Error {},
}))

import {
  getMediaProvidersSync,
  seedProviders,
  useMediaProviderStore,
} from '../media-provider-store'

// --- fake adapters ----------------------------------------------------------

let fakeAdapters: Record<string, MediaProviderAdapter>

function capabilitiesFor(
  providerId: string,
  localIds: string[]
): MediaCapabilities {
  return {
    contract_version: 2,
    provider_id: providerId,
    devices: [],
    models: localIds.map((localId) => ({
      id: `${providerId}:${localId}`,
      provider_id: providerId,
      local_id: localId,
      label: `${localId} on ${providerId}`,
      tasks: ['text_to_image'],
      params: { text_to_image: [] },
    })),
    features: { cancel: false },
  }
}

function onlineAdapter(
  descriptor: MediaProviderDescriptor,
  localIds: string[]
): MediaProviderAdapter {
  return {
    descriptor,
    health: async () => ({ state: 'online', version: '1.0.0' }),
    capabilities: async () => capabilitiesFor(descriptor.id, localIds),
    submit: async () => {
      throw new Error('not used')
    },
    poll: async () => {
      throw new Error('not used')
    },
  }
}

function offlineAdapter(
  descriptor: MediaProviderDescriptor
): MediaProviderAdapter {
  return {
    descriptor,
    health: async () => ({ state: 'offline', detail: 'refused' }),
    capabilities: async () => {
      throw new Error('provider is offline')
    },
    submit: async () => {
      throw new Error('not used')
    },
    poll: async () => {
      throw new Error('not used')
    },
  }
}

const comfy: MediaProviderDescriptor = {
  id: 'comfy-local',
  label: 'ComfyUI',
  kind: 'local_comfy',
  adapter: 'comfyui',
  base_url: 'http://127.0.0.1:8188',
  enabled: true,
  origin: 'user',
}

const engine = BASELINE_MEDIA_PROVIDERS[0]!

beforeEach(() => {
  localStorage.clear()
  fakeAdapters = {
    [BUILTIN_ENGINE_PROVIDER_ID]: onlineAdapter(engine, ['shared-model']),
    'comfy-local': onlineAdapter(comfy, ['shared-model', 'comfy-only']),
  }
  useMediaProviderStore.setState({
    providers: BASELINE_MEDIA_PROVIDERS.map((p) => ({ ...p })),
    health: {},
    capabilities: {},
    errors: {},
    selectedModelId: null,
    refreshing: false,
  })
})

describe('media provider store', () => {
  describe('baseline', () => {
    it('has exactly the built-in engine on first run, enabled', () => {
      const providers = useMediaProviderStore.getState().providers

      expect(providers).toHaveLength(1)
      expect(providers[0]).toMatchObject({
        id: BUILTIN_ENGINE_PROVIDER_ID,
        adapter: 'builtin-engine',
        origin: 'builtin',
        enabled: true,
      })
    })

    // Radium never shipped or started the Media Worker, so the old builtin
    // entry was offline for everyone (2026-09-15).
    it('drops the retired builtin worker from saved settings', () => {
      const savedWorker: MediaProviderDescriptor = {
        id: ATOMIC_MEDIA_WORKER_PROVIDER_ID,
        label: 'Radium Media Worker',
        kind: 'local_worker',
        adapter: 'atomic-media-worker',
        base_url: 'http://127.0.0.1:13420',
        enabled: true,
        origin: 'builtin',
      }

      expect(seedProviders([savedWorker, comfy]).map((p) => p.id)).toEqual([
        'comfy-local',
        BUILTIN_ENGINE_PROVIDER_ID,
      ])
    })

    it('keeps a worker the user added themselves', () => {
      const ownWorker: MediaProviderDescriptor = {
        id: ATOMIC_MEDIA_WORKER_PROVIDER_ID,
        label: 'My worker',
        kind: 'local_worker',
        adapter: 'atomic-media-worker',
        base_url: 'http://127.0.0.1:13420',
        enabled: true,
        origin: 'user',
      }

      expect(seedProviders([ownWorker]).map((p) => p.id)).toEqual([
        ATOMIC_MEDIA_WORKER_PROVIDER_ID,
        BUILTIN_ENGINE_PROVIDER_ID,
      ])
    })

    it('exposes providers synchronously for non-React callers', () => {
      expect(getMediaProvidersSync()).toEqual(
        useMediaProviderStore.getState().providers
      )
    })
  })

  describe('enable and disable', () => {
    it('persists a disabled builtin provider', () => {
      useMediaProviderStore
        .getState()
        .setProviderEnabled(BUILTIN_ENGINE_PROVIDER_ID, false)

      expect(useMediaProviderStore.getState().providers[0]?.enabled).toBe(false)
      const persisted = JSON.parse(
        localStorage.getItem(localStorageKey.mediaProviders) ?? '{}'
      )
      expect(persisted.state.providers[0].enabled).toBe(false)
    })

    it('re-enables it again', () => {
      const { setProviderEnabled } = useMediaProviderStore.getState()
      setProviderEnabled(BUILTIN_ENGINE_PROVIDER_ID, false)
      setProviderEnabled(BUILTIN_ENGINE_PROVIDER_ID, true)

      expect(useMediaProviderStore.getState().providers[0]?.enabled).toBe(true)
    })
  })

  describe('user-added providers', () => {
    it('persists a provider the user adds', () => {
      useMediaProviderStore.getState().addProvider(comfy)

      const persisted = JSON.parse(
        localStorage.getItem(localStorageKey.mediaProviders) ?? '{}'
      )
      expect(
        persisted.state.providers.map((p: MediaProviderDescriptor) => p.id)
      ).toEqual([BUILTIN_ENGINE_PROVIDER_ID, 'comfy-local'])
    })

    it('refuses to add a second provider with an id already in use', () => {
      useMediaProviderStore.getState().addProvider(comfy)
      useMediaProviderStore.getState().addProvider({ ...comfy, label: 'Dupe' })

      const providers = useMediaProviderStore.getState().providers
      expect(providers.filter((p) => p.id === 'comfy-local')).toHaveLength(1)
      expect(providers.find((p) => p.id === 'comfy-local')?.label).toBe(
        'ComfyUI'
      )
    })

    it('removes a user provider and forgets its runtime state', async () => {
      const store = useMediaProviderStore.getState()
      store.addProvider(comfy)
      await useMediaProviderStore.getState().refresh()

      useMediaProviderStore.getState().removeProvider('comfy-local')

      const state = useMediaProviderStore.getState()
      expect(state.providers.map((p) => p.id)).toEqual([
        BUILTIN_ENGINE_PROVIDER_ID,
      ])
      expect(state.capabilities['comfy-local']).toBeUndefined()
      expect(state.health['comfy-local']).toBeUndefined()
    })

    it('never removes a builtin provider, only disables it', () => {
      useMediaProviderStore
        .getState()
        .removeProvider(BUILTIN_ENGINE_PROVIDER_ID)

      const providers = useMediaProviderStore.getState().providers
      expect(providers.map((p) => p.id)).toEqual([
        BUILTIN_ENGINE_PROVIDER_ID,
      ])
    })
  })

  describe('refresh', () => {
    it('tracks health per provider', async () => {
      useMediaProviderStore.getState().addProvider(comfy)

      await useMediaProviderStore.getState().refresh()

      const { health } = useMediaProviderStore.getState()
      expect(health[BUILTIN_ENGINE_PROVIDER_ID]?.state).toBe('online')
      expect(health['comfy-local']?.state).toBe('online')
    })

    it('merges two providers into one model list without id collision', async () => {
      useMediaProviderStore.getState().addProvider(comfy)

      await useMediaProviderStore.getState().refresh()

      const models = useMediaProviderStore.getState().models()
      // Both providers expose a model whose local id is 'shared-model'. The
      // provider-qualified ids are what keep them distinct.
      expect(models.map((m) => m.id).sort()).toEqual([
        'builtin-engine:shared-model',
        'comfy-local:comfy-only',
        'comfy-local:shared-model',
      ])
      expect(new Set(models.map((m) => m.id)).size).toBe(models.length)
    })

    it('keeps one failing provider from blocking another', async () => {
      useMediaProviderStore.getState().addProvider(comfy)
      fakeAdapters['comfy-local'] = offlineAdapter(comfy)

      await useMediaProviderStore.getState().refresh()

      const state = useMediaProviderStore.getState()
      // The healthy provider still produced its models.
      expect(state.capabilities[BUILTIN_ENGINE_PROVIDER_ID]).toBeTruthy()
      expect(state.models().map((m) => m.id)).toEqual([
        'builtin-engine:shared-model',
      ])
      // And the failure is recorded against the provider that failed, only.
      expect(state.errors['comfy-local']).toMatch(/offline/i)
      expect(state.errors[BUILTIN_ENGINE_PROVIDER_ID]).toBeNull()
      expect(state.health['comfy-local']?.state).toBe('offline')
    })

    it('does not contact a disabled provider', async () => {
      useMediaProviderStore.getState().addProvider(comfy)
      const health = vi.fn(async () => ({ state: 'online' as const }))
      fakeAdapters['comfy-local'] = { ...onlineAdapter(comfy, []), health }
      useMediaProviderStore.getState().setProviderEnabled('comfy-local', false)

      await useMediaProviderStore.getState().refresh()

      expect(health.mock.calls).toEqual([])
      expect(
        useMediaProviderStore.getState().health['comfy-local']
      ).toBeUndefined()
    })

    it('gives up on a provider that never answers, without hanging', async () => {
      useMediaProviderStore.getState().addProvider(comfy)
      fakeAdapters['comfy-local'] = {
        ...onlineAdapter(comfy, []),
        health: (signal?: AbortSignal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () =>
              reject(new Error('aborted'))
            )
          }),
        capabilities: (signal?: AbortSignal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () =>
              reject(new Error('aborted'))
            )
          }),
      }

      await useMediaProviderStore.getState().refresh({ timeoutMs: 10 })

      const state = useMediaProviderStore.getState()
      expect(state.refreshing).toBe(false)
      expect(state.errors['comfy-local']).toBeTruthy()
      // The provider that did answer is unaffected.
      expect(state.health[BUILTIN_ENGINE_PROVIDER_ID]?.state).toBe('online')
    })

    it('clears refreshing even when every provider fails', async () => {
      fakeAdapters[BUILTIN_ENGINE_PROVIDER_ID] = offlineAdapter(engine)

      await useMediaProviderStore.getState().refresh()

      expect(useMediaProviderStore.getState().refreshing).toBe(false)
    })
  })

  describe('selection', () => {
    it('clears a selection that pointed at a disabled provider', async () => {
      useMediaProviderStore.getState().addProvider(comfy)
      await useMediaProviderStore.getState().refresh()
      useMediaProviderStore.getState().setSelectedModel('comfy-local:comfy-only')

      useMediaProviderStore.getState().setProviderEnabled('comfy-local', false)

      expect(useMediaProviderStore.getState().selectedModelId).toBeNull()
    })

    it('drops the disabled provider’s models from the merged list', async () => {
      useMediaProviderStore.getState().addProvider(comfy)
      await useMediaProviderStore.getState().refresh()

      useMediaProviderStore.getState().setProviderEnabled('comfy-local', false)

      expect(useMediaProviderStore.getState().models().map((m) => m.id)).toEqual(
        ['builtin-engine:shared-model']
      )
    })

    it('keeps a selection that points at a provider still enabled', async () => {
      useMediaProviderStore.getState().addProvider(comfy)
      await useMediaProviderStore.getState().refresh()
      useMediaProviderStore
        .getState()
        .setSelectedModel('builtin-engine:shared-model')

      useMediaProviderStore.getState().setProviderEnabled('comfy-local', false)

      expect(useMediaProviderStore.getState().selectedModelId).toBe(
        'builtin-engine:shared-model'
      )
    })

    it('clears a selection when its provider is removed', async () => {
      useMediaProviderStore.getState().addProvider(comfy)
      await useMediaProviderStore.getState().refresh()
      useMediaProviderStore.getState().setSelectedModel('comfy-local:shared-model')

      useMediaProviderStore.getState().removeProvider('comfy-local')

      expect(useMediaProviderStore.getState().selectedModelId).toBeNull()
    })
  })

  describe('secrets', () => {
    it('persists only a setting key reference, never a secret value', () => {
      useMediaProviderStore.getState().addProvider({
        ...comfy,
        id: 'cloud-x',
        kind: 'remote_http',
        adapter: 'custom-http',
        auth: { type: 'api_key', setting_key: 'media.cloud-x.apiKey' },
      })

      const raw = localStorage.getItem(localStorageKey.mediaProviders) ?? ''
      // The descriptor may name where a secret lives; the secret itself must
      // never reach this store or its persisted blob.
      expect(raw).toContain('media.cloud-x.apiKey')
      expect(raw).not.toMatch(/api_key"\s*:\s*"[^"]/)
      const persisted = JSON.parse(raw)
      const cloud = persisted.state.providers.find(
        (p: MediaProviderDescriptor) => p.id === 'cloud-x'
      )
      expect(Object.keys(cloud.auth)).toEqual(['type', 'setting_key'])
    })
  })
})
