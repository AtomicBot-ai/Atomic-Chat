import { useCallback, useMemo } from 'react'

import { SETUP_SCREEN_QUANTIZATIONS } from '@/constants/models'
import {
  fitLevel,
  interleaveByPublisher,
  orderRowsByFit,
  pickMmprojModel,
  pickPreferredVariant,
  publisherKey,
} from '@/containers/SetupScreenHelpers'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useHardwareTier } from '@/hooks/useHardwareTier'
import { useModelSources } from '@/hooks/useModelSources'
import { useResolvedRecommendedModels } from '@/hooks/useResolvedRecommendedModels'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useStaffPicks } from '@/hooks/useStaffPicks'
import { judgeMemoryFit, type MemoryFit } from '@/lib/hardware-tier'
import { findPinnedQuant, parseFileSizeToBytes } from '@/lib/model-card'
import { prettyModelName } from '@/lib/model-display-name'
import { getTotalDownloadFileSize } from '@/lib/models'
import type { CatalogModel, ModelQuant } from '@/services/models/types'

export type RecommendedDownload = {
  /** Hugging Face repo id, e.g. `AtomicChat/Qwen3.5-4B-GGUF`. */
  repo: string
  title: string
  /** i18n key for the one-line reason, from the manifest. */
  descriptionKey: string
  /**
   * The Hub's own one-line summary, for a staff pick. The manifest's rows
   * carry only `descriptionKey`.
   */
  summary?: string
  /** Resolved catalog card. */
  model: CatalogModel
  /** The exact file a download would fetch. */
  variant: ModelQuant
  /**
   * Size of everything `start()` fetches — the quant plus its projector — as
   * the catalog prints it (`4.2 GB`); undefined when the card does not say.
   * The figure onboarding prints beside the name and judges the fit on.
   */
  sizeLabel?: string
  sizeBytes?: number
  /** How that size sits in this machine's memory; `null` when either is unknown. */
  fit: MemoryFit | null
  isDownloading: boolean
  /** Starts the download. Returns the model id started, or `null` if it could not. */
  start: () => string | null
}

type DownloadSpec = {
  repo: string
  title: string
  descriptionKey: string
  summary?: string
  model: CatalogModel
  variant: ModelQuant
  /** Pinned multimodal projector quant, for vision entries. */
  mmprojQuant?: string
}

/**
 * Everything a row needs beyond its card — its size, its fit, whether it is
 * already on its way, and the download behind its button — shared by both
 * lists below so a click in either fetches the same files the same way.
 */
function useDownloadBuilder() {
  const serviceHub = useServiceHub()
  const { profile } = useHardwareTier()
  const huggingfaceToken = useGeneralSetting((s) => s.huggingfaceToken)
  const {
    downloads,
    localDownloadingModels,
    resumableDownloads,
    addLocalDownloadingModel,
    clearResumableDownload,
  } = useDownloadStore()

  return useCallback(
    (spec: DownloadSpec): RecommendedDownload => {
      const { model, variant } = spec
      const mmproj = pickMmprojModel(model, spec.mmprojQuant)
      const label = getTotalDownloadFileSize(model, variant, mmproj ?? null)
      const sizeBytes = parseFileSizeToBytes(label)
      return {
        repo: spec.repo,
        title: spec.title,
        descriptionKey: spec.descriptionKey,
        summary: spec.summary,
        model,
        variant,
        // A size the catalog cannot state as a figure is no size at all.
        sizeLabel: sizeBytes ? label : undefined,
        sizeBytes,
        fit: judgeMemoryFit(sizeBytes, profile),
        isDownloading:
          localDownloadingModels.has(variant.model_id) ||
          Object.values(downloads).some((d) => d.id === variant.model_id),
        start: () => {
          clearResumableDownload(variant.model_id)
          addLocalDownloadingModel(variant.model_id)
          serviceHub
            .models()
            .pullModelWithMetadata(
              variant.model_id,
              variant.path,
              mmproj?.path,
              huggingfaceToken,
              true,
              resumableDownloads.has(variant.model_id)
            )
          return variant.model_id
        },
      }
    },
    [
      profile,
      localDownloadingModels,
      downloads,
      resumableDownloads,
      addLocalDownloadingModel,
      clearResumableDownload,
      serviceHub,
      huggingfaceToken,
    ]
  )
}

type DownloadBuilder = ReturnType<typeof useDownloadBuilder>

/** The file a manifest row fetches: the pin, else the house quant, else the first. */
function pickLadderVariant(
  model: CatalogModel,
  quant?: string
): ModelQuant | null {
  // The pin wins: a repo can ship a Q4_K_M that the loop below would match
  // too, and without the pin the download takes the wrong file silently.
  const pinned = findPinnedQuant(model.quants, quant)
  if (pinned) return pinned
  for (const quantization of SETUP_SCREEN_QUANTIZATIONS) {
    const found = model.quants?.find((q) =>
      q.model_id.toLowerCase().includes(quantization)
    )
    if (found) return found
  }
  return model.quants?.[0] ?? null
}

/**
 * The manifest's rows for this machine, best fit first, up to `limit`.
 *
 * Only rows whose card has resolved: a row that cannot be downloaded yet is
 * a spinner with a disabled button, and two of those in a row read as a
 * broken list. The lead is waited for rather than skipped, so a later row
 * never wears "best fit" while the real one is still on its way. The rest
 * are dropped when they would not load here: the base hook steps the lead
 * down the ladder, but not the flat list it appends after it.
 */
function useLadderDownloads(
  limit: number,
  build: DownloadBuilder
): { items: RecommendedDownload[]; isLoading: boolean } {
  const { sources } = useModelSources()
  const { tier, profile } = useHardwareTier()
  const resolved = useResolvedRecommendedModels(sources, tier, profile)

  const items = useMemo<RecommendedDownload[]>(() => {
    const out: RecommendedDownload[] = []
    const seen = new Set<string>()
    if (resolved.length > 0 && !resolved[0].model) return out
    for (const { rec, model } of resolved) {
      if (out.length >= limit) break
      if (!model || model.is_mlx) continue
      const variant = pickLadderVariant(model, rec.quant)
      if (!variant) continue
      const key = variant.model_id.toLowerCase()
      if (seen.has(key)) continue
      const item = build({
        repo: rec.modelName,
        title: prettyModelName(rec.modelName),
        descriptionKey: rec.descriptionKey,
        model,
        variant,
        mmprojQuant: rec.mmprojQuant,
      })
      if (out.length > 0 && item.fit === 'wont_load') continue
      seen.add(key)
      out.push(item)
    }
    return out
  }, [resolved, limit, build])

  // Nothing resolved yet, though there is something to resolve.
  const isLoading = items.length === 0 && resolved.length > 0

  return { items, isLoading }
}

/**
 * The local models the manifest recommends for this machine, best fit first,
 * each with the download behind it.
 *
 * The manifest's rung for this tier, stepped down until it fits, with the
 * bundled ladder as the fallback — the offer onboarding leads with, and what
 * the reminder card and the composer's model list repeat, so no surface
 * offers a second opinion on the lead. GGUF only: it is the format every
 * platform runs, and the one both surfaces open on; MLX twins stay behind the
 * Hub's format filter.
 */
export function useRecommendedDownloads(limit = 3): {
  items: RecommendedDownload[]
  isLoading: boolean
} {
  const build = useDownloadBuilder()
  return useLadderDownloads(limit, build)
}

/**
 * The list onboarding's "Recommended models" section shows, row for row,
 * each with its download: the offer first — `useRecommendedDownloads`' lead —
 * then every one of the Hub's GGUF staff picks, listed by how they fit this
 * machine (what fits, then what is tight, then what will not load) and dealt
 * so no two neighbours share a publisher. The ordering is the screen's own
 * (`orderRowsByFit`, `interleaveByPublisher`), so the two surfaces cannot
 * disagree on what comes after the offer.
 *
 * Nothing is dropped for size: a pick that will not load here is listed with
 * its verdict, as onboarding lists it. Left out are the offer's own repo and
 * file, and any pick whose card has not resolved — a row is listed only once
 * it can be downloaded, so a late card joins the list at its colour when it
 * lands. The manifest's own tail (its flat `recommendations`) is not a row
 * here, as it is not one on onboarding.
 */
export function useRecommendedListDownloads(): {
  items: RecommendedDownload[]
  isLoading: boolean
} {
  const build = useDownloadBuilder()
  const { items: ladder, isLoading } = useLadderDownloads(1, build)
  const { sources } = useModelSources()
  const picks = useStaffPicks(sources, 'gguf')
  const lead: RecommendedDownload | undefined = ladder[0]

  const items = useMemo<RecommendedDownload[]>(() => {
    if (isLoading) return []
    const seen = new Set<string>()
    const leadRepo = lead?.repo.toLowerCase()
    if (lead) seen.add(lead.variant.model_id.toLowerCase())

    const rows: Array<{ item: RecommendedDownload; icon?: string }> = []
    for (const { pick, model } of picks) {
      if (!model || model.is_mlx) continue
      if (pick.model_name.toLowerCase() === leadRepo) continue
      const variant = pickPreferredVariant(model)
      if (!variant) continue
      const key = variant.model_id.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      rows.push({
        icon: pick.icon,
        item: build({
          repo: pick.model_name,
          title: pick.title ?? prettyModelName(model.model_name),
          descriptionKey: pick.description_key ?? 'hub:recEverydayUse',
          summary: pick.summary,
          model,
          variant,
        }),
      })
    }

    const ordered = orderRowsByFit(rows, {
      levelOf: (row) => fitLevel(row.item.fit),
      keyOf: (row) => publisherKey(row.item.repo, row.icon),
      interleave: interleaveByPublisher,
      previous: lead ? publisherKey(lead.repo) : undefined,
    })
    return [...(lead ? [lead] : []), ...ordered.map((row) => row.item)]
  }, [isLoading, lead, picks, build])

  return { items, isLoading }
}
