import { useEffect, useState } from 'react'

import { useModelProvider } from '@/hooks/useModelProvider'
import { curatedLiteRtLmCard, hfLiteRtLmCard, hostLiteRtLmPlatform } from '@/lib/litert-lm/hub'
import { fetchLiteRtLmList, type LiteRtLmList } from '@/services/litert-lm/curated'
import { fetchHfLiteRtModels } from '@/services/litert-lm/huggingface'
import type { CatalogModel } from '@/services/models/types'

const LITERT_LM_PROVIDER = 'litert-lm'

/**
 * Whether the Hub offers the "LiteRT-LM" format: exactly where the provider is shown, which is
 * where the core registered it (change add-litert-lm-runtime, spec "Model Hub предлагает модели
 * LiteRT-LM"). The app checks no platform itself.
 */
export function useLiteRtLmHubVisible(): boolean {
  return useModelProvider((state) =>
    state.providers.some((provider) => provider.provider === LITERT_LM_PROVIDER)
  )
}

export interface LiteRtLmHubState {
  curated: CatalogModel[]
  huggingFace: CatalogModel[]
  /** Hugging Face could not be listed; the curated list is shown alone, with a note. */
  huggingFaceUnavailable: boolean
  /** The list the cards came from. */
  list: LiteRtLmList | null
  loading: boolean
}

const EMPTY: LiteRtLmHubState = {
  curated: [],
  huggingFace: [],
  huggingFaceUnavailable: false,
  list: null,
  loading: false,
}

/**
 * The LiteRT-LM list of the Hub: conf's curated models, then the Hugging Face models of conf's
 * organisations for this platform's allowed backends, the ones `query` names (the most downloaded
 * without one). Read only while the format is shown; Hugging Face is asked once per Hub session for
 * what a view shows (`fetchHfLiteRtModels`).
 */
export function useLiteRtLmHub(enabled: boolean, query: string): LiteRtLmHubState {
  const [state, setState] = useState<LiteRtLmHubState>(EMPTY)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    setState((current) => ({ ...current, loading: true }))
    void (async () => {
      const { list } = await fetchLiteRtLmList()
      const curated = (list?.models ?? []).map(curatedLiteRtLmCard)
      if (cancelled) return
      setState((current) => ({ ...current, curated, list, loading: !!list }))
      if (!list) return
      const platform = hostLiteRtLmPlatform()
      const huggingFace = await fetchHfLiteRtModels({
        orgs: list.huggingface.orgs,
        allowed: list.huggingface.backends[platform] ?? [],
        platform,
        curated: list.models,
        query,
      })
      if (cancelled) return
      setState({
        curated,
        huggingFace: huggingFace.models.map(hfLiteRtLmCard),
        huggingFaceUnavailable: huggingFace.unavailable,
        list,
        loading: false,
      })
    })()
    return () => {
      cancelled = true
    }
  }, [enabled, query])

  return enabled ? state : EMPTY
}
