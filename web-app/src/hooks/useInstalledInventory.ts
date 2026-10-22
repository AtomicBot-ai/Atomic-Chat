import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useVoiceModel } from '@/hooks/useVoiceModel'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  decisionDownloadTaskId,
  deleteDecisionModel,
} from '@/lib/decision/models'
import { cancelDownload } from '@/lib/downloadCancellation'
import { resumeDownload } from '@/lib/downloadResume'
import {
  EMPTY_DISK_SCAN,
  removeDiskPaths,
  scanDownloadsDisk,
  type DownloadsDiskScan,
} from '@/lib/downloads-disk'
import {
  deleteEmbeddingModel,
  embeddingDownloadTaskId,
} from '@/lib/embedding/models'
import { MLX_PROVIDER } from '@/lib/hub-installed'
import {
  activeDownloadIds,
  artifactItems,
  decisionItems,
  downloadItems,
  draftItems,
  embeddingItems,
  engineBuildItems,
  inventoryTotalBytes,
  isDownloadActive,
  mlxDraftersOn,
  partialDownloadItems,
  providerModelItems,
  sortInventory,
  voiceItem,
  withMeasuredSizes,
  type InventoryItem,
} from '@/lib/installed-inventory'
import { deleteLocalModel } from '@/lib/model-deletion'
import type { ServiceHub } from '@/services'
import { deleteEngineBuild } from '@/services/engines/core'
import { useDecisionStore } from '@/stores/decision-store'
import { useEmbeddingStore } from '@/stores/embedding-store'
import { useEngineVersionsStore } from '@/stores/engine-versions-store'
import { useImageGenerationStore } from '@/stores/image-generation-store'

/** Thrown for an item its owner refuses to remove; the page never offers it. */
export class InventoryNotRemovableError extends Error {
  constructor(readonly item: InventoryItem) {
    super(`${item.name} cannot be removed (${item.notRemovableReason})`)
    this.name = 'InventoryNotRemovableError'
  }
}

/**
 * Refusal codes for what the disk holds without an owner; the page words them.
 * `DOWNLOAD_ACTIVE`: the partial files belong to a download running or paused
 * since the list was read. `DRAFT_IN_USE`: MLX speculative decoding was turned on.
 */
export type DiskRemovalRefusal = 'DOWNLOAD_ACTIVE' | 'DRAFT_IN_USE'

const refuse = (code: DiskRemovalRefusal, item: InventoryItem): Error =>
  Object.assign(new Error(`${item.name} cannot be removed now (${code})`), {
    code,
  })

/**
 * Remove one item through the owner that put it there, the way that owner's
 * own page removes it: the provider registry for model files, the
 * image-generation store for checkpoints, the embedding and decision helpers
 * (which first switch the core off a model it runs), the voice hook (which
 * releases the transcription engine first) and the core for engine builds.
 * Partial downloads and MLX drafts have no owner keeping a list: their files
 * are deleted, once the download store and the MLX drafter switches say again
 * that nothing uses them, and the disk is read again (`rescan`).
 * Rejects with the owner's refusal; resolves once the owner's list is re-read.
 */
export async function removeInventoryItem(
  item: InventoryItem,
  deps: {
    serviceHub: ServiceHub
    removeVoice: () => Promise<void>
    rescan?: () => Promise<void>
  }
): Promise<void> {
  const removal = item.removal
  if (!removal || item.notRemovableReason) {
    throw new InventoryNotRemovableError(item)
  }
  switch (removal.type) {
    case 'model':
      await deleteLocalModel(deps.serviceHub, removal.modelId, removal.provider)
      return
    case 'artifact':
      await useImageGenerationStore
        .getState()
        .removeArtifact(removal.artifactId)
      return
    case 'embedding': {
      const store = useEmbeddingStore.getState()
      try {
        await deleteEmbeddingModel(removal.model, store.config)
        useDownloadStore
          .getState()
          .clearResumableDownload(embeddingDownloadTaskId(removal.model.id))
      } finally {
        await Promise.all([store.refreshInstalled(), store.refresh()])
      }
      return
    }
    case 'decision': {
      const store = useDecisionStore.getState()
      try {
        await deleteDecisionModel(removal.model, store.config)
        useDownloadStore
          .getState()
          .clearResumableDownload(decisionDownloadTaskId(removal.model.id))
      } finally {
        await Promise.all([store.refreshInstalled(), store.refresh()])
      }
      return
    }
    case 'voice':
      await deps.removeVoice()
      return
    case 'engine-build':
      try {
        await deleteEngineBuild(
          removal.engine,
          removal.version,
          removal.variant
        )
      } finally {
        await useEngineVersionsStore.getState().refresh()
      }
      return
    case 'partial':
      if (
        isDownloadActive(
          removal.downloadId,
          activeDownloadIds(useDownloadStore.getState())
        )
      ) {
        throw refuse('DOWNLOAD_ACTIVE', item)
      }
      try {
        await removeDiskPaths(removal.paths)
      } finally {
        await deps.rescan?.()
      }
      return
    case 'draft':
      if (mlxDraftersOn(useModelProvider.getState().providers)) {
        throw refuse('DRAFT_IN_USE', item)
      }
      try {
        await removeDiskPaths([removal.path])
      } finally {
        await deps.rescan?.()
      }
      return
  }
}

export type InstalledInventory = {
  /** Running downloads first, then everything installed. */
  items: InventoryItem[]
  /** Bytes on disk across the installed items, shared files counted once. */
  totalBytes: number
  remove: (item: InventoryItem) => Promise<void>
  /** Cancel a running download, as the download panel does. */
  cancel: (item: InventoryItem) => void
  /** Resume a paused download, as the download panel does. */
  resume: (item: InventoryItem) => void
}

/**
 * Everything the app downloaded to this computer, merged from the stores
 * that own each kind (see `lib/installed-inventory.ts`). The embedding and
 * decision stores follow the core only while a page asks, so this hook binds
 * them for as long as it is mounted; the others are bound app-wide.
 */
export function useInstalledInventory(): InstalledInventory {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const providers = useModelProvider((state) => state.providers)
  const voice = useVoiceModel()

  const diffusionCatalog = useImageGenerationStore((state) => state.catalog)
  const installedArtifacts = useImageGenerationStore(
    (state) => state.installedArtifacts
  )
  const modelFiles = useImageGenerationStore((state) => state.modelFiles)

  const embeddingModels = useEmbeddingStore((state) => state.catalog.models)
  const embeddingInstalled = useEmbeddingStore((state) => state.installed)
  const decisionModels = useDecisionStore((state) => state.catalog.models)
  const decisionInstalled = useDecisionStore((state) => state.installed)

  const engines = useEngineVersionsStore((state) => state.engines)

  const downloads = useDownloadStore((state) => state.downloads)
  const localDownloadingModels = useDownloadStore(
    (state) => state.localDownloadingModels
  )
  const pausedDownloads = useDownloadStore((state) => state.pausedDownloads)
  const downloadOriginByModelId = useDownloadStore(
    (state) => state.downloadOriginByModelId
  )

  const resumableDownloads = useDownloadStore(
    (state) => state.resumableDownloads
  )

  useEffect(() => useEmbeddingStore.getState().bind(), [])
  useEffect(() => useDecisionStore.getState().bind(), [])

  const activeIds = useMemo(
    () =>
      activeDownloadIds({
        downloads,
        localDownloadingModels,
        pausedDownloads,
        resumableDownloads,
      }),
    [downloads, localDownloadingModels, pausedDownloads, resumableDownloads]
  )

  // What the disk holds that no owner records: MLX folder sizes, MLX drafts and
  // partial downloads. Read again whenever the local models or the downloads
  // the app holds change (a download that finishes turns its partials into a
  // model), and after a removal.
  const [disk, setDisk] = useState<DownloadsDiskScan>(EMPTY_DISK_SCAN)
  const diskRef = useRef(disk)
  const unsizedMlxIds = useMemo(
    () =>
      (
        providers.find((provider) => provider.provider === MLX_PROVIDER)
          ?.models ?? []
      )
        .filter((model) => !(model.sizeBytes && model.sizeBytes > 0))
        .map((model) => model.id),
    [providers]
  )
  const localModelsKey = useMemo(
    () =>
      providers
        .filter((provider) => provider.persist)
        .flatMap((provider) => provider.models.map((model) => model.id))
        .sort()
        .join('\n'),
    [providers]
  )
  const scanKey = `${unsizedMlxIds.join('\n')}|${localModelsKey}|${[...activeIds].sort().join('\n')}`
  const scanSeq = useRef(0)
  const unsizedRef = useRef(unsizedMlxIds)
  unsizedRef.current = unsizedMlxIds
  const rescan = useCallback(async () => {
    const seq = ++scanSeq.current
    let next: DownloadsDiskScan
    try {
      next = await scanDownloadsDisk(unsizedRef.current)
    } catch (error) {
      console.warn('[downloads] reading the download folders failed:', error)
      return
    }
    // A later read owns the result; an empty one over nothing changes nothing.
    if (seq !== scanSeq.current) return
    const empty =
      next.partials.length === 0 &&
      next.drafts.length === 0 &&
      Object.keys(next.mlxModelBytes).length === 0
    if (empty && diskRef.current === EMPTY_DISK_SCAN) return
    diskRef.current = empty ? EMPTY_DISK_SCAN : next
    setDisk(diskRef.current)
  }, [])
  useEffect(() => {
    void rescan()
  }, [rescan, scanKey])

  const draftersOn = useMemo(() => mlxDraftersOn(providers), [providers])

  const items = useMemo(() => {
    const voiceRow = voiceItem(providers, voice.installed)
    return sortInventory([
      ...downloadItems({
        downloads,
        localDownloadingModels,
        pausedDownloads,
        downloadOriginByModelId,
        diffusionCatalog,
        embeddingModels,
        decisionModels,
      }),
      ...withMeasuredSizes(providerModelItems(providers), disk.mlxModelBytes),
      ...partialDownloadItems(disk.partials, activeIds),
      ...draftItems(disk.drafts, draftersOn),
      ...artifactItems(diffusionCatalog, installedArtifacts, modelFiles),
      ...embeddingItems(embeddingModels, embeddingInstalled),
      ...decisionItems(decisionModels, decisionInstalled),
      ...(voiceRow ? [voiceRow] : []),
      ...engineBuildItems(engines),
    ])
  }, [
    providers,
    disk,
    activeIds,
    draftersOn,
    voice.installed,
    downloads,
    localDownloadingModels,
    pausedDownloads,
    downloadOriginByModelId,
    diffusionCatalog,
    installedArtifacts,
    modelFiles,
    embeddingModels,
    embeddingInstalled,
    decisionModels,
    decisionInstalled,
    engines,
  ])

  const totalBytes = useMemo(() => inventoryTotalBytes(items), [items])

  const removeVoice = voice.remove
  const remove = useCallback(
    (item: InventoryItem) =>
      removeInventoryItem(item, { serviceHub, removeVoice, rescan }),
    [serviceHub, removeVoice, rescan]
  )

  const cancel = useCallback(
    (item: InventoryItem) => {
      if (!item.download) return
      cancelDownload(
        { id: item.download.id, name: item.download.name },
        serviceHub
      )
    },
    [serviceHub]
  )

  const resume = useCallback(
    (item: InventoryItem) => {
      if (!item.download?.paused) return
      resumeDownload(
        { id: item.download.id, name: item.download.name },
        { serviceHub, t }
      )
    },
    [serviceHub, t]
  )

  return { items, totalBytes, remove, cancel, resume }
}
