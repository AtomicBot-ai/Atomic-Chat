import { useEffect, useMemo } from 'react'

import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import {
  parseHubFileUrl,
  PRISM_PROVIDER,
  prismFamilyCards,
} from '@/lib/model-setup'
import type { CompatibilityVerdict } from '@/services/model-setup/types'
import type { CatalogModel } from '@/services/models/types'
import { useModelCompatibilityStore } from '@/stores/model-compatibility-store'

/** Verdict requests in flight, so two rows of one file ask the core once. */
const asking = new Set<string>()
/** The families request in flight, so two lists ask the core once. */
let askingFamilies = false

/**
 * Forgets the verdicts and the Bonsai families whenever a new core generation
 * attaches: it may run another PrismML build or newer model rules. Mount
 * once, at the app root.
 */
export function useModelCompatibilitySync(): void {
  const serviceHub = useServiceHub()

  useEffect(() => {
    const service = serviceHub.modelSetup()
    if (!service.isSupported()) return
    return service.onCoreReset(() =>
      useModelCompatibilityStore.getState().reset()
    )
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
  const verdict = useModelCompatibilityStore((state) =>
    url ? state.verdicts[url] : undefined
  )
  const known = useModelCompatibilityStore((state) =>
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
      .then((answer) => useModelCompatibilityStore.getState().setVerdict(url, answer))
      .catch(() => useModelCompatibilityStore.getState().setVerdict(url, null))
      .finally(() => asking.delete(url))
  }, [url, known, serviceHub])

  return verdict
}

/**
 * Whether the Hub offers its PrismML list: where the provider is shown. The
 * core hides it where PrismML publishes no build (Linux and Windows on Arm).
 */
export function usePrismHubVisible(): boolean {
  return useModelProvider((state) =>
    state.providers.some((provider) => provider.provider === PRISM_PROVIDER)
  )
}

/**
 * The Hub's PrismML list: the Bonsai families of the core's model rules, as
 * cards, asked once per core generation. Empty where there is no core, and
 * until the next generation when the core could not answer.
 */
export function usePrismFamilies(enabled: boolean): {
  models: CatalogModel[]
  loading: boolean
} {
  const serviceHub = useServiceHub()
  const families = useModelCompatibilityStore((state) => state.families)

  useEffect(() => {
    if (!enabled || families !== null || askingFamilies) return
    const service = serviceHub.modelSetup()
    if (!service.isSupported()) {
      useModelCompatibilityStore.getState().setFamilies([])
      return
    }
    askingFamilies = true
    service
      .families()
      .then((answer) =>
        useModelCompatibilityStore.getState().setFamilies(answer.families)
      )
      .catch((error) => {
        console.warn('[model-setup] could not list the Bonsai families:', error)
        useModelCompatibilityStore.getState().setFamilies([])
      })
      .finally(() => {
        askingFamilies = false
      })
  }, [enabled, families, serviceHub])

  const models = useMemo(() => prismFamilyCards(families ?? []), [families])
  return { models, loading: enabled && families === null }
}
