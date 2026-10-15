import { useEffect, useState } from 'react'

import { useModelProvider } from '@/hooks/useModelProvider'
import { catalogHubCard, curatedHubCard } from '@/lib/foundry-local/hub'
import { fetchFoundryLocalList, type FoundryLocalList } from '@/services/foundry-local/curated'
import { fetchMicrosoftCatalog } from '@/services/foundry-local/microsoft-catalog'
import type { CatalogModel } from '@/services/models/types'

const FOUNDRY_LOCAL_PROVIDER = 'foundry-local'

/**
 * Whether the Hub offers the "Foundry Local" format: exactly where the provider is shown, which is
 * where the core registered it (change add-foundry-local, spec "Model Hub предлагает модели Foundry
 * Local"). The app checks no platform itself.
 */
export function useFoundryLocalHubVisible(): boolean {
  return useModelProvider((state) =>
    state.providers.some((provider) => provider.provider === FOUNDRY_LOCAL_PROVIDER)
  )
}

export interface FoundryLocalHubState {
  curated: CatalogModel[]
  catalog: CatalogModel[]
  /** Microsoft's catalog could not be read; the curated list is shown alone, with a note. */
  catalogUnavailable: boolean
  /** The list the cards came from (its resolver is what the installer asks). */
  list: FoundryLocalList | null
  loading: boolean
}

const EMPTY: FoundryLocalHubState = {
  curated: [],
  catalog: [],
  catalogUnavailable: false,
  list: null,
  loading: false,
}

/**
 * The Foundry Local list of the Hub: conf's curated models, then Microsoft's catalog (asked once per
 * Hub session by its client). Read only while the format is shown.
 */
export function useFoundryLocalHub(enabled: boolean): FoundryLocalHubState {
  const [state, setState] = useState<FoundryLocalHubState>(EMPTY)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    setState((current) => ({ ...current, loading: true }))
    void (async () => {
      const { list } = await fetchFoundryLocalList()
      const curated = (list?.models ?? []).map(curatedHubCard)
      if (cancelled) return
      setState((current) => ({ ...current, curated, list, loading: !!list }))
      if (!list) return
      const catalog = await fetchMicrosoftCatalog({ url: list.catalog.url, curated: list.models })
      if (cancelled) return
      setState({
        curated,
        catalog: catalog.models.map(catalogHubCard),
        catalogUnavailable: catalog.unavailable,
        list,
        loading: false,
      })
    })()
    return () => {
      cancelled = true
    }
  }, [enabled])

  return enabled ? state : EMPTY
}
