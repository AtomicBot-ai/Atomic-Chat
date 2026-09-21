import { useCallback, useMemo } from 'react'
import { toast } from 'sonner'

import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useHardwareTier } from '@/hooks/useHardwareTier'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { fitForQuant } from '@/lib/diffusion/fit'
import { isDownloadCancellationError } from '@/lib/downloadCancellation'
import {
  cancelArtifactDownload,
  diffusionDownloadTaskId,
  downloadArtifact,
  parseArtifactId,
  planArtifactDownload,
  workflowNeedsLlmVision,
  type InstalledArtifact,
} from '@/lib/diffusion/models'
import type { HardwareFit } from '@/lib/model-card'
import type { DiffusionOffloadPolicy } from '@/services/diffusion/types'
import {
  findFamily,
  findQuant,
  type DiffusionCatalogFamily,
  type DiffusionCatalogQuant,
} from '@/services/diffusion-catalog-registry'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { useImageForm } from './useImageForm'

export type ImageArtifactState = {
  id: string
  family: DiffusionCatalogFamily | null
  quant: DiffusionCatalogQuant | null
  /** Bytes of the whole artifact: transformer plus the side files it needs. */
  totalBytes: number
  installed: InstalledArtifact | null
  /** Every file is on disk. */
  complete: boolean
  /** True while the transformer or a side file is being fetched. */
  downloading: boolean
  /** 0..1 */
  progress: number
  currentBytes: number
  downloadTotalBytes: number
  fit: HardwareFit
  fitReason: string
  offloadPolicy: DiffusionOffloadPolicy
  /** This artifact is the resident model. */
  loaded: boolean
  /** A load is in flight for this artifact. */
  loading: boolean
  /** An unload is in flight for this artifact. */
  unloading: boolean
  download: () => Promise<void>
  cancelDownload: () => Promise<void>
  remove: () => Promise<void>
  load: () => Promise<void>
}

/**
 * Everything the UI needs to know about one `<family>:<quantId>` checkpoint.
 *
 * Purely derived — the catalog and the installed list live in the generation
 * store, progress in `useDownloadStore` — so the model selector, the setup
 * dialog and the settings page can never disagree about a checkpoint.
 */
export function useImageArtifact(id: string): ImageArtifactState {
  const { t } = useTranslation()
  const catalog = useImageGenerationStore((state) => state.catalog)
  const installedArtifacts = useImageGenerationStore(
    (state) => state.installedArtifacts
  )
  const status = useImageGenerationStore((state) => state.status)
  const capabilities = useImageGenerationStore((state) => state.capabilities)
  const modelFiles = useImageGenerationStore((state) => state.modelFiles)
  const paths = useImageGenerationStore((state) => state.paths)
  const loadingArtifactId = useImageGenerationStore(
    (state) => state.loadingArtifactId
  )
  const unloadingArtifactId = useImageGenerationStore(
    (state) => state.unloadingArtifactId
  )
  const loadModel = useImageGenerationStore((state) => state.loadModel)
  const removeArtifact = useImageGenerationStore(
    (state) => state.removeArtifact
  )
  const refreshModelFiles = useImageGenerationStore(
    (state) => state.refreshModelFiles
  )
  const downloads = useDownloadStore((state) => state.downloads)
  const huggingfaceToken = useGeneralSetting((state) => state.huggingfaceToken)
  const { profile } = useHardwareTier()
  const workflow = useImageForm((state) => state.workflow)

  const { family, quant } = useMemo(() => {
    const parsed = catalog ? parseArtifactId(id) : null
    if (!catalog || !parsed) return { family: null, quant: null }
    const fam = findFamily(catalog, parsed.family) ?? null
    const q = fam ? (findQuant(fam, parsed.quantId) ?? null) : null
    return { family: fam, quant: q }
  }, [catalog, id])

  const installed = useMemo(
    () => installedArtifacts.find((artifact) => artifact.id === id) ?? null,
    [installedArtifacts, id]
  )

  const fit = useMemo(() => {
    if (!family || !quant) {
      return { fit: 'no' as const, policy: 'none' as const, reason: '' }
    }
    return fitForQuant(family, quant, profile, { teOnCpu: IS_MACOS })
  }, [family, quant, profile])

  const workflowPlan = useMemo(() => {
    if (!family || !quant) return null
    return planArtifactDownload(
      family,
      quant.id,
      modelFiles,
      paths?.modelsRoot ?? '',
      { workflow }
    )
  }, [family, modelFiles, paths, quant, workflow])

  const totalBytes = workflowPlan?.totalBytes ?? 0

  const progressEntry = downloads[diffusionDownloadTaskId(id)]
  const downloading = Boolean(progressEntry)

  const download = useCallback(async () => {
    if (!family || !quant) return
    try {
      await downloadArtifact(family, quant.id, {
        hfToken: huggingfaceToken,
        resume: true,
        workflow,
      })
      await refreshModelFiles()
    } catch (error) {
      // Pause and Cancel stop the same underlying transfer. Their global
      // panel feedback owns those states; neither is a failed model download.
      if (isDownloadCancellationError(error)) return
      console.error('[images] artifact download failed:', error)
      toast.error(t('images:model.downloadFailed', { name: family.name }), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }, [family, quant, huggingfaceToken, refreshModelFiles, t, workflow])

  const cancelDownload = useCallback(async () => {
    try {
      await cancelArtifactDownload(id)
    } finally {
      await refreshModelFiles()
    }
  }, [id, refreshModelFiles])

  const remove = useCallback(() => removeArtifact(id), [id, removeArtifact])
  const load = useCallback(() => loadModel(id), [id, loadModel])

  return {
    id,
    family,
    quant,
    totalBytes,
    installed,
    complete: workflowPlan
      ? workflowPlan.missingBytes === 0
      : (installed?.complete ?? false),
    downloading,
    progress: progressEntry?.progress ?? 0,
    currentBytes: progressEntry?.current ?? 0,
    downloadTotalBytes: progressEntry?.total || totalBytes,
    fit: fit.fit,
    fitReason: fit.reason,
    offloadPolicy: fit.policy,
    loaded:
      status?.model.loaded?.modelId === id &&
      (!workflowNeedsLlmVision(workflow) ||
        Boolean(capabilities?.workflows.includes(workflow))),
    loading: loadingArtifactId === id,
    unloading: unloadingArtifactId === id,
    download,
    cancelDownload,
    remove,
    load,
  }
}
