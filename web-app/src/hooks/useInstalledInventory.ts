import { useCallback, useEffect, useMemo } from 'react'

import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useVoiceModel } from '@/hooks/useVoiceModel'
import {
  decisionDownloadTaskId,
  deleteDecisionModel,
} from '@/lib/decision/models'
import { cancelDownload } from '@/lib/downloadCancellation'
import {
  deleteEmbeddingModel,
  embeddingDownloadTaskId,
} from '@/lib/embedding/models'
import {
  artifactItems,
  decisionItems,
  downloadItems,
  embeddingItems,
  engineBuildItems,
  inventoryTotalBytes,
  providerModelItems,
  sortInventory,
  voiceItem,
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
 * Remove one item through the owner that put it there, the way that owner's
 * own page removes it: the provider registry for model files, the
 * image-generation store for checkpoints, the embedding and decision helpers
 * (which first switch the core off a model it runs), the voice hook (which
 * releases the transcription engine first) and the core for engine builds.
 * Rejects with the owner's refusal; resolves once the owner's list is re-read.
 */
export async function removeInventoryItem(
  item: InventoryItem,
  deps: { serviceHub: ServiceHub; removeVoice: () => Promise<void> }
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
}

/**
 * Everything the app downloaded to this computer, merged from the stores
 * that own each kind (see `lib/installed-inventory.ts`). The embedding and
 * decision stores follow the core only while a page asks, so this hook binds
 * them for as long as it is mounted; the others are bound app-wide.
 */
export function useInstalledInventory(): InstalledInventory {
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

  useEffect(() => useEmbeddingStore.getState().bind(), [])
  useEffect(() => useDecisionStore.getState().bind(), [])

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
      ...providerModelItems(providers),
      ...artifactItems(diffusionCatalog, installedArtifacts, modelFiles),
      ...embeddingItems(embeddingModels, embeddingInstalled),
      ...decisionItems(decisionModels, decisionInstalled),
      ...(voiceRow ? [voiceRow] : []),
      ...engineBuildItems(engines),
    ])
  }, [
    providers,
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
      removeInventoryItem(item, { serviceHub, removeVoice }),
    [serviceHub, removeVoice]
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

  return { items, totalBytes, remove, cancel }
}
