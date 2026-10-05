import { useEffect, useMemo } from 'react'

import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import {
  latestSetupFor,
  parseHubFileUrl,
  setupBytes,
  type HubFile,
  type TaskProgress,
} from '@/lib/model-setup'
import type {
  CompatibilityVerdict,
  ModelSetup,
} from '@/services/model-setup/types'
import { useModelSetupStore } from '@/stores/model-setup-store'

/** Verdict requests in flight, so two rows of one file ask the core once. */
const asking = new Set<string>()

/**
 * Keeps the store in step with the core's setups: the list on attach and on
 * every new core generation, then each change as it is written. A setup that
 * reaches `ready` registered a model, so the providers are read again — the
 * same refresh an ordinary download ends with. Mount once, at the app root.
 */
export function useModelSetupSync(): void {
  const serviceHub = useServiceHub()

  useEffect(() => {
    const service = serviceHub.modelSetup()
    if (!service.isSupported()) return
    const store = useModelSetupStore.getState()

    const relist = () => {
      service
        .list()
        .then((setups) => useModelSetupStore.getState().replaceAll(setups))
        .catch((error) =>
          console.debug('[model-setup] could not list setups:', error)
        )
    }

    const refreshProviders = async (setup: ModelSetup) => {
      const { clearDeletedModel, setProviders } = useModelProvider.getState()
      clearDeletedModel(setup.plan.model_id)
      try {
        setProviders(await serviceHub.providers().getProviders())
      } catch (error) {
        console.error('[model-setup] could not refresh providers:', error)
      }
    }

    const unsubscribe = service.subscribe((event) => {
      if (event.type === 'changed' && event.setup.stage === 'ready') {
        const known = useModelSetupStore.getState().setups[event.setup.setup_id]
        if (known?.stage !== 'ready') void refreshProviders(event.setup)
      }
      useModelSetupStore.getState().apply(event)
      if (event.type === 'reset') relist()
    })
    store.apply({ type: 'reset' })
    relist()
    return unsubscribe
  }, [serviceHub])
}

/**
 * The core's verdict on one Hub file, asked lazily from the conf rules alone
 * (no remote header read, so no download per row). `undefined` while unknown
 * or where there is no core; `null` when the core could not say.
 */
export function useCompatibilityVerdict(
  url: string | undefined
): CompatibilityVerdict | null | undefined {
  const serviceHub = useServiceHub()
  const verdict = useModelSetupStore((state) =>
    url ? state.verdicts[url] : undefined
  )
  const known = useModelSetupStore((state) =>
    url ? Object.hasOwn(state.verdicts, url) : false
  )

  useEffect(() => {
    if (!url || known || asking.has(url)) return
    const service = serviceHub.modelSetup()
    const file = parseHubFileUrl(url)
    if (!service.isSupported() || !file) return
    asking.add(url)
    service
      .checkCompatibility({ ...file, provider: 'llamacpp-upstream' })
      .then((answer) => useModelSetupStore.getState().setVerdict(url, answer))
      .catch(() => useModelSetupStore.getState().setVerdict(url, null))
      .finally(() => asking.delete(url))
  }, [url, known, serviceHub])

  return verdict
}

/** The newest setup of one Hub file, if any was ever started. */
export function useHubFileSetup(file: HubFile | null): ModelSetup | undefined {
  const setups = useModelSetupStore((state) => state.setups)
  return useMemo(
    () => (file ? latestSetupFor(Object.values(setups), file) : undefined),
    [setups, file]
  )
}

/** Bytes done over bytes to do across a setup's downloads. */
export function useModelSetupBytes(
  setup: ModelSetup | undefined
): TaskProgress {
  const progress = useModelSetupStore((state) => state.progress)
  return useMemo(
    () => (setup ? setupBytes(setup, progress) : { transferred: 0, total: 0 }),
    [setup, progress]
  )
}
