import { fetch as fetchTauri } from '@tauri-apps/plugin-http'
import { qualcommSearch } from '@/services/geniex/qualcomm'
import { useEffect, useMemo, useState } from 'react'

import { useModelProvider } from '@/hooks/useModelProvider'
import {
  bundleGeniexCard,
  curatedGeniexCard,
  qualcommGeniexCards,
  qualcommGgufCard,
  ggufCandidates,
  hfGeniexCard,
  hostGeniexPlatform,
} from '@/lib/geniex/hub'
import { geniexAccelerators } from '@/services/geniex/core'
import { fetchGeniexList, type GeniexList } from '@/services/geniex/curated'
import { fetchHfGeniexModels } from '@/services/geniex/huggingface'
import type { GeniexChip } from '@/services/geniex/types'
import { getModelSearchService } from '@/services/model-search'
import type { CatalogModel } from '@/services/models/types'

const searchQualcomm = qualcommSearch((url, options) =>
  (typeof IS_TAURI !== 'undefined' && IS_TAURI ? fetchTauri : fetch)(url, options)
)

const GENIEX_PROVIDER = 'geniex'

/**
 * Whether the Hub offers the "GenieX" format: exactly where the provider is shown, which is where
 * the core registered it (change add-geniex-runtime, spec geniex-desktop "Model Hub предлагает
 * модели GenieX на двух полках"). The app checks no platform or processor itself.
 */
export function useGeniexHubVisible(): boolean {
  return useModelProvider((state) =>
    state.providers.some((provider) => provider.provider === GENIEX_PROVIDER)
  )
}

/** This computer's chip, asked once per app session: the core's accelerators answer names it. */
let chipPromise: Promise<GeniexChip | null> | null = null

export function readGeniexChip(): Promise<GeniexChip | null> {
  chipPromise ??= geniexAccelerators()
    .then((answer) => answer.chip)
    .catch(() => {
      chipPromise = null
      return null
    })
  return chipPromise
}

/** Forget the chip (tests). */
export function resetGeniexChipForTest(): void {
  chipPromise = null
}

/** The chip of this computer, `null` until the core has answered (or where it registered no GenieX). */
export function useGeniexChip(enabled = true): GeniexChip | null {
  const [chip, setChip] = useState<GeniexChip | null>(null)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void readGeniexChip().then((answer) => {
      if (!cancelled) setChip(answer)
    })
    return () => {
      cancelled = true
    }
  }, [enabled])
  return enabled ? chip : null
}

export interface GeniexHubState {
  /** The GGUF shelf's curated models. */
  curated: CatalogModel[]
  /** The GGUF shelf's Hugging Face models, for this view's query. */
  huggingFace: CatalogModel[]
  /** The AI Hub shelf: every curated bundle model; the rows keep the ones for this chip. */
  bundles: CatalogModel[]
  /** Hugging Face could not be listed; the curated list is shown alone, with a note. */
  qualcommUnavailable?: boolean
  huggingFaceUnavailable: boolean
  chip: GeniexChip | null
  /** The list the cards came from. */
  list: GeniexList | null
  loading: boolean
}

const EMPTY: GeniexHubState = {
  curated: [],
  huggingFace: [],
  bundles: [],
  huggingFaceUnavailable: false,
  chip: null,
  list: null,
  loading: false,
}

/**
 * The GenieX list of the Hub: conf's curated GGUF models and bundles, then the Hugging Face GGUF
 * repositories the catalog search finds for `query` (the most relevant without one), with conf's
 * quantizations and devices for this platform. Read only while the format is shown; each
 * repository's tree is asked once per Hub session (`fetchHfGeniexModels`).
 */
export function useGeniexHub(enabled: boolean, query: string): GeniexHubState {
  const [state, setState] = useState<GeniexHubState>(EMPTY)
  const chip = useGeniexChip(enabled)
  const list = enabled ? state.list : null

  const [vendor, setVendor] = useState({
    ggufs: [] as CatalogModel[],
    models: [] as CatalogModel[],
    unavailable: false,
    loading: false,
  })
  useEffect(() => {
    if (!enabled || !chip) return
    let live = true
    setVendor({ ggufs: [], models: [], unavailable: false, loading: true })
    const timer = setTimeout(() => {
      const excluded = new Set(
        list?.models.flatMap((m) => (m.kind === 'qairt' ? m.variants.map((v) => v.bundle.url) : [])) ?? []
      )
      void searchQualcomm(query, chip, excluded).then((result) => {
        if (live)
          setVendor({
            ggufs: list?.huggingface.backends['win-arm64']?.length
              ? result.ggufs.map((g) => qualcommGgufCard(g, list.huggingface.backends['win-arm64']!))
              : [],
            models: result.models.flatMap(qualcommGeniexCards),
            unavailable: result.unavailable,
            loading: false,
          })
      })
    }, 180)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [enabled, chip, list, query])
  const bundles = useMemo(
    () => (chip ? [...state.bundles, ...vendor.models] : state.bundles),
    [chip, state.bundles, vendor.models]
  )

  // conf's list, once each time the format is shown: a search does not read it again.
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    setState((current) => ({ ...current, loading: true }))
    void fetchGeniexList().then(({ list: fetched }) => {
      if (cancelled) return
      const models = fetched?.models ?? []
      setState((current) => ({
        ...current,
        curated: models.flatMap((model) => (model.kind === 'gguf' ? [curatedGeniexCard(model)] : [])),
        bundles: models.flatMap((model) => (model.kind === 'qairt' ? [bundleGeniexCard(model)] : [])),
        list: fetched,
        loading: !!fetched,
      }))
    })
    return () => {
      cancelled = true
    }
  }, [enabled])

  // Hugging Face, for the catalog search's GGUF repositories and this view's query.
  useEffect(() => {
    if (!list) return
    let cancelled = false
    const platform = hostGeniexPlatform()
    const search = getModelSearchService()
    const candidates = ggufCandidates(query ? search.search(query) : search.defaultRanking())
    void fetchHfGeniexModels({
      candidates,
      quantizations: list.huggingface.quantizations,
      allowed: list.huggingface.backends[platform] ?? [],
      platform,
      curated: list.models.map((model) => ({
        id: model.id,
        ...(model.kind === 'gguf' ? { repo: model.gguf.repo } : {}),
      })),
    }).then((huggingFace) => {
      if (cancelled) return
      setState((current) => ({
        ...current,
        huggingFace: huggingFace.models.map(hfGeniexCard),
        huggingFaceUnavailable: huggingFace.unavailable,
        loading: false,
      }))
    })
    return () => {
      cancelled = true
    }
  }, [list, query])

  const huggingFace = useMemo(() => {
    const seen = new Set(
      [...state.curated, ...state.huggingFace]
        .map((c) => c.geniex?.gguf)
        .filter(Boolean)
        .map((g) => g!.repo.toLowerCase() + '/' + g!.file.path)
    )
    return [
      ...state.huggingFace,
      ...vendor.ggufs.filter((c) => {
        const g = c.geniex?.gguf
        return g && !seen.has(g.repo.toLowerCase() + '/' + g.file.path)
      }),
    ]
  }, [state.curated, state.huggingFace, vendor.ggufs])
  return enabled
    ? {
        ...state,
        chip,
        bundles,
        huggingFace,
        loading: state.loading || (!!chip && vendor.loading),
        qualcommUnavailable: !!chip && vendor.unavailable,
      }
    : EMPTY
}
