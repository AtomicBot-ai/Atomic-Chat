import { useCallback, useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/shallow'

import {
  fitLevel,
  interleaveByPublisher,
  orderRowsByFit,
  pickMmprojModel,
  pickPreferredVariant,
  publisherKey,
  type FitLevel,
} from '@/containers/SetupScreenHelpers'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useHardware } from '@/hooks/useHardware'
import { useHardwareTier } from '@/hooks/useHardwareTier'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useModelSources } from '@/hooks/useModelSources'
import { useResolvedRecommendedModels } from '@/hooks/useResolvedRecommendedModels'
import { useStaffPicks } from '@/hooks/useStaffPicks'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { isAnswerableModel } from '@/lib/answerable-model'
import { judgeMemoryFit, type HardwareProfile } from '@/lib/hardware-tier'
import { iconKeyLogoSrc, modelFamilyLogoSrc } from '@/lib/model-logo'
import { prettyModelName } from '@/lib/model-display-name'
import { parseFileSizeToBytes } from '@/lib/model-card'
import { getMlxTotalFileSize, getTotalDownloadFileSize } from '@/lib/models'
import { ggufMatchIds, mlxMatchIds } from '@/lib/onboarding/jobs'
import { mlxModelId } from '@/lib/onboarding/downloads'
import {
  baseModelKey,
  catalogTags,
  isFirstRunChatRepo,
  modelTagline,
  repoKey,
} from '@/lib/onboarding/taglines'
import { LOCAL_LLAMACPP_PROVIDER } from '@/lib/utils'
import {
  collectImportedModelPaths,
  scanLocalModels,
  type LocalModelCandidate,
} from '@/services/models/localScan'
import { getDownloadFreeSpace } from '@/services/models/downloadPreflight'
import type { CatalogModel, ModelQuant } from '@/services/models/types'
import { useRecommendedModelsRegistryStore } from '@/stores/recommended-models-registry-store'
import { useStaffPicksStore } from '@/stores/staff-picks-store'

/**
 * Neither the on-disk scan nor the hardware enumeration may hold the screen
 * hostage: whatever has not answered by then counts as "nothing found" or the
 * fallback tier.
 */
export const MODEL_INPUT_DEADLINE_MS = 4_000

/** How many offers the screen shows: the best fit and two more. */
const RECOMMENDED_ROWS = 3

/** How many Hugging Face models follow the offers. */
const HUGGING_FACE_ROWS = 12

/** Engines whose models are files on this machine. */
const LIBRARY_PROVIDERS = new Set([
  'llamacpp',
  'llamacpp-upstream',
  'atomic-prism',
  'mlx',
])

type OptionBase = {
  key: string
  title: string
  /** What the row is good for, in one line; every row has one. */
  detail: string
  iconSrc: string | null
  /** Provider model ids it registers under, for "is it ready". */
  matchIds: string[]
  provider: string
}

export type ModelOption =
  /** Already in the app's library. */
  | (OptionBase & { kind: 'library'; modelId: string })
  /** Found on disk from another app; imported on Continue. */
  | (OptionBase & { kind: 'scan'; candidate: LocalModelCandidate })
  /** Offered for download. */
  | (OptionBase & {
      kind: 'download'
      catalog: CatalogModel
      variant: ModelQuant | null
      mmprojPath?: string
      isMlx: boolean
      /** The id the download runs under. */
      taskId: string
      sizeLabel: string | null
      sizeBytes: number | undefined
      fit: FitLevel | null
      bestFit: boolean
      /** Which list offers it: the device's offers or Hugging Face's. */
      source: 'recommended' | 'huggingface'
      /** The row's index across both lists, as impressions report it. */
      position: number
    })

export type DownloadOption = Extract<ModelOption, { kind: 'download' }>

/** The machine, as the device card describes it. */
export type DeviceSummary = {
  name: string | null
  memoryGb: number | null
  freeGb: number | null
}

const gb = (bytes: number | null | undefined) =>
  bytes && bytes > 0 ? Math.round((bytes / 1024 ** 3) * 10) / 10 : null

function downloadOption(
  catalog: CatalogModel,
  {
    title,
    detail,
    iconSrc,
    quant,
    mmprojQuant,
    bestFit,
    profile,
  }: {
    title: string
    detail: string
    iconSrc: string | null
    quant?: string
    mmprojQuant?: string
    bestFit: boolean
    profile: HardwareProfile | null
  }
): Omit<DownloadOption, 'position' | 'source'> | null {
  const isMlx = Boolean(catalog.is_mlx)
  const variant = isMlx ? null : pickPreferredVariant(catalog, quant)
  if (!isMlx && !variant) return null
  const mmproj = isMlx ? undefined : pickMmprojModel(catalog, mmprojQuant)
  const sizeLabel =
    (isMlx
      ? getMlxTotalFileSize(catalog)
      : getTotalDownloadFileSize(catalog, variant!, mmproj)) ?? null
  const sizeBytes = parseFileSizeToBytes(sizeLabel ?? undefined)
  const taskId = isMlx ? mlxModelId(catalog) : variant!.model_id
  return {
    kind: 'download',
    key: `download:${catalog.model_name}`,
    title,
    detail,
    iconSrc,
    catalog,
    variant,
    mmprojPath: mmproj?.path,
    isMlx,
    taskId,
    provider: isMlx ? 'mlx' : LOCAL_LLAMACPP_PROVIDER,
    matchIds: isMlx
      ? mlxMatchIds(catalog.developer, catalog.model_name)
      : ggufMatchIds(catalog.developer, variant!.model_id),
    sizeLabel,
    sizeBytes,
    fit: fitLevel(judgeMemoryFit(sizeBytes, profile)),
    bestFit,
  }
}

/**
 * Everything the model step offers, built from what the app already knows:
 * models in the library, models other apps left on disk, the recommendation
 * for this machine's tier and two of the Hub's curated picks after it, then
 * the most downloaded chat models of the Hugging Face catalog.
 *
 * `ready` stays false until the scan and the hardware tier answered (or the
 * deadline passed), so the list never reshuffles under the user.
 */
export function useModelOptions() {
  const { t } = useTranslation()
  const tagline = useCallback(
    (name: string, tags?: readonly string[]) =>
      t(`onboarding:model.tagline.${modelTagline(name, tags)}`),
    [t]
  )
  const providers = useModelProvider((state) => state.providers)
  const { sources, fetchSources, loading } = useModelSources(
    useShallow((state) => ({
      sources: state.sources,
      fetchSources: state.fetchSources,
      loading: state.loading,
    }))
  )
  const { tier, profile, ready: tierReady } = useHardwareTier()
  const [deadlinePassed, setDeadlinePassed] = useState(false)
  const [candidates, setCandidates] = useState<LocalModelCandidate[] | null>(
    null
  )

  useEffect(() => {
    void fetchSources()
    // The registry's one-hour cache is served without touching the network;
    // this screen's whole content is the list, so it asks for a fresh one.
    void useRecommendedModelsRegistryStore.getState().refresh({ force: true })
    void useStaffPicksStore.getState().refresh({ force: true })
  }, [fetchSources])

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      if (cancelled) return
      setDeadlinePassed(true)
      setCandidates((previous) => previous ?? [])
    }, MODEL_INPUT_DEADLINE_MS)
    const { scanLocalModels: enabled, localScanFolders } =
      useGeneralSetting.getState()
    void scanLocalModels({
      enabled,
      extraRoots: localScanFolders,
      importedPaths: collectImportedModelPaths(
        useModelProvider.getState().providers
      ),
    })
      .then((found) => {
        if (!cancelled) setCandidates(found)
      })
      .catch((error) => {
        console.debug('[onboarding] local scan failed', error)
        if (!cancelled) setCandidates([])
      })
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [])

  const recommendedItems = useResolvedRecommendedModels(sources, tier, profile)
  const staffPickItems = useStaffPicks(sources, 'gguf')

  const library = useMemo<ModelOption[]>(
    () =>
      providers
        .filter(
          (provider) =>
            LIBRARY_PROVIDERS.has(provider.provider) &&
            provider.active !== false
        )
        .flatMap((provider) =>
          provider.models.filter(isAnswerableModel).map((model) => ({
            kind: 'library' as const,
            key: `library:${provider.provider}:${model.id}`,
            title: prettyModelName(model.name || model.id),
            detail: tagline(model.name || model.id),
            iconSrc: modelFamilyLogoSrc(model.id),
            provider: provider.provider,
            modelId: model.id,
            matchIds: [model.id],
          }))
        ),
    [providers, tagline]
  )

  const detected = useMemo<ModelOption[]>(
    () =>
      (candidates ?? [])
        .filter((candidate) => candidate.runnable)
        .map((candidate) => ({
          kind: 'scan' as const,
          key: `scan:${candidate.path}`,
          title: prettyModelName(candidate.displayName),
          detail: tagline(candidate.displayName),
          iconSrc: modelFamilyLogoSrc(candidate.displayName),
          provider:
            candidate.format === 'mlx' ? 'mlx' : LOCAL_LLAMACPP_PROVIDER,
          matchIds: [candidate.id],
          candidate,
        })),
    [candidates, tagline]
  )

  // A pick's curated summary describes any upload of the same model: the
  // tier's offer and the Hugging Face rows read it before a tagline.
  const summaries = useMemo(
    () =>
      new Map(
        staffPickItems.flatMap(({ pick }) =>
          pick.summary?.trim()
            ? [[repoKey(pick.model_name), pick.summary.trim()] as const]
            : []
        )
      ),
    [staffPickItems]
  )
  const describe = useCallback(
    (model: CatalogModel) =>
      summaries.get(repoKey(model.model_name)) ??
      tagline(model.model_name, catalogTags(model)),
    [summaries, tagline]
  )

  const recommended = useMemo<DownloadOption[]>(() => {
    const inLibrary = new Set(library.flatMap((option) => option.matchIds))
    const onDisk = (option: Omit<DownloadOption, 'position' | 'source'>) =>
      option.matchIds.some((id) => inLibrary.has(id))
    const taken = new Set<string>()
    const rows: Omit<DownloadOption, 'position' | 'source'>[] = []

    // The rung of the ladder this machine sits on leads, unless it is
    // already here; then the next one does.
    for (const { rec, model } of recommendedItems) {
      if (!model) continue
      const option = downloadOption(model, {
        title: prettyModelName(model.model_name),
        detail: describe(model),
        iconSrc: modelFamilyLogoSrc(rec.modelName),
        quant: rec.quant,
        mmprojQuant: rec.mmprojQuant,
        bestFit: true,
        profile,
      })
      taken.add(rec.modelName.toLowerCase())
      if (option && !onDisk(option)) {
        rows.push(option)
        break
      }
    }

    const picks: Omit<DownloadOption, 'position' | 'source'>[] = []
    for (const { pick, model } of staffPickItems) {
      const name = pick.model_name.toLowerCase()
      if (!model || taken.has(name)) continue
      taken.add(name)
      const option = downloadOption(model, {
        title: pick.title ?? prettyModelName(model.model_name),
        detail:
          pick.summary?.trim() || tagline(model.model_name, catalogTags(model)),
        iconSrc:
          iconKeyLogoSrc(pick.icon) ?? modelFamilyLogoSrc(pick.model_name),
        bestFit: false,
        profile,
      })
      if (option && !onDisk(option)) picks.push(option)
    }
    const ordered = orderRowsByFit(picks, {
      levelOf: (row) => row.fit,
      keyOf: (row) => publisherKey(row.catalog.model_name),
      interleave: interleaveByPublisher,
      previous: rows[0] ? publisherKey(rows[0].catalog.model_name) : undefined,
    })
    // Only what this machine can run is offered after the lead.
    for (const row of ordered) {
      if (rows.length >= RECOMMENDED_ROWS) break
      if (row.fit !== 'no') rows.push(row)
    }
    return rows.map((row, position) => ({
      ...row,
      source: 'recommended' as const,
      position,
    }))
  }, [recommendedItems, staffPickItems, library, profile, describe, tagline])

  // After the offers, the catalog's most downloaded chat models this machine
  // runs, one upload per model, none already offered or here.
  const huggingFace = useMemo<DownloadOption[]>(() => {
    const inLibrary = new Set(library.flatMap((option) => option.matchIds))
    const offered = new Set(
      recommended.map((option) => option.catalog.model_name.toLowerCase())
    )
    const bases = new Set(
      recommended.map((option) => baseModelKey(option.catalog))
    )
    const rows: DownloadOption[] = []
    const byDownloads = sources
      .filter(
        (model) =>
          !model.is_mlx &&
          !model.is_managed &&
          !model.is_foundry_local &&
          !model.is_litert_lm &&
          !model.is_geniex &&
          isFirstRunChatRepo(model)
      )
      .sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0))
    for (const model of byDownloads) {
      if (rows.length >= HUGGING_FACE_ROWS) break
      const base = baseModelKey(model)
      if (offered.has(model.model_name.toLowerCase()) || bases.has(base))
        continue
      const option = downloadOption(model, {
        title: prettyModelName(model.model_name),
        detail: describe(model),
        iconSrc: modelFamilyLogoSrc(model.model_name),
        bestFit: false,
        profile,
      })
      if (!option || option.fit === 'no') continue
      if (option.matchIds.some((id) => inLibrary.has(id))) continue
      bases.add(base)
      rows.push({
        ...option,
        key: `huggingface:${model.model_name}`,
        source: 'huggingface',
        position: recommended.length + rows.length,
      })
    }
    return rows
  }, [sources, recommended, library, profile, describe])

  const [freeBytes, setFreeBytes] = useState<number | null>(null)
  useEffect(() => {
    let cancelled = false
    void getDownloadFreeSpace()
      .then((report) => {
        if (!cancelled) setFreeBytes(report?.available ?? null)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const cpuName = useHardware((state) => state.hardwareData.cpu?.name)
  const device: DeviceSummary = {
    name: cpuName?.trim() || null,
    memoryGb: profile ? Math.round(profile.systemRamMib / 1024) : null,
    freeGb: gb(freeBytes),
  }

  return {
    ready: candidates !== null && (tierReady || deadlinePassed),
    catalogLoading: loading,
    onDevice: [...library, ...detected],
    detected,
    library,
    recommended,
    huggingFace,
    device,
    tier,
    tierReady,
    profile,
  }
}
