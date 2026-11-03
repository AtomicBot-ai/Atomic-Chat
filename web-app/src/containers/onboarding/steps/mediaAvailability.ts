import { useMemo } from 'react'

import { useHardwareTier } from '@/hooks/useHardwareTier'
import {
  fitForQuant,
  pickDefaultQuant,
  type DiffusionFit,
} from '@/lib/diffusion/fit'
import {
  artifactId,
  planArtifactDownload,
  type InstalledArtifact,
} from '@/lib/diffusion/models'
import type { HardwareProfile } from '@/lib/hardware-tier'
import { DIFFUSION_FAMILY_ICON_KEYS, iconKeyLogoSrc } from '@/lib/model-logo'
import { PlatformFeatures } from '@/lib/platform/const'
import { PlatformFeature } from '@/lib/platform/types'
import type {
  DiffusionFamilyId,
  DiffusionModality,
  DiffusionModelFile,
} from '@/services/diffusion/types'
import {
  findFamily,
  type DiffusionCatalog,
} from '@/services/diffusion-catalog-registry'
import { useImageGenerationStore } from '@/stores/image-generation-store'

/** The families the media step offers, in the order of their cards. */
const MEDIA_FAMILY_IDS: readonly DiffusionFamilyId[] = ['z-image', 'ltx-2']

/** One card of the media step: a family at the quant this machine should get. */
export type MediaCard = {
  family: DiffusionFamilyId
  modality: DiffusionModality
  title: string
  /** The family's mark, as the Hub shows it; `null` when none is bundled. */
  logoSrc: string | null
  /** The model file a queued job downloads (`family:quantId`). */
  artifactId: string
  /** Bytes still to fetch; the whole artifact once it is on disk. */
  downloadBytes: number
  /** What the model holds in memory while it runs, at the family's default size. */
  memoryBytes: number
  /** `maybe` runs, but only with most of the memory: the card says so. */
  fit: Exclude<DiffusionFit, 'no'>
  /** Every file of the artifact is on disk already. */
  downloaded: boolean
}

/**
 * The cards for what the catalog lists. The quant is the one the Hub opens a
 * family on: one already on disk that runs here, else the recommended one. A
 * family with no quant this machine can run gets no card — offering a model
 * that will not load helps nobody.
 */
function mediaCards(
  catalog: DiffusionCatalog,
  modelFiles: DiffusionModelFile[],
  installed: InstalledArtifact[],
  profile: HardwareProfile | null
): MediaCard[] {
  return MEDIA_FAMILY_IDS.flatMap((id): MediaCard[] => {
    const family = findFamily(catalog, id)
    if (!family || family.transformer.quants.length === 0) return []
    const quant = pickDefaultQuant(
      family,
      profile,
      installed
        .filter((artifact) => artifact.family === family.id)
        .map((artifact) => artifact.id),
      { teOnCpu: IS_MACOS }
    )
    const estimate = fitForQuant(family, quant, profile, { teOnCpu: IS_MACOS })
    if (estimate.fit === 'no') return []
    // Matched on relative paths, as the installed list is: no models root needed.
    const plan = planArtifactDownload(family, quant.id, modelFiles, '')
    const downloaded = plan.missingBytes === 0
    return [
      {
        family: family.id,
        modality: family.modality,
        title: family.name,
        logoSrc: iconKeyLogoSrc(DIFFUSION_FAMILY_ICON_KEYS[family.id]),
        artifactId: artifactId(family.id, quant.id),
        downloadBytes: downloaded ? plan.totalBytes : plan.missingBytes,
        memoryBytes: estimate.residentBytes,
        fit: estimate.fit,
        downloaded,
      },
    ]
  })
}

/**
 * Image and video models this machine can run, as cards of the media step.
 * Nothing until the answer is known — the media feature on this platform, an
 * engine build for this host (or one installed), the catalog and the memory —
 * so a card never shows up only to be taken back.
 */
export function useMediaCards(): MediaCard[] {
  const catalog = useImageGenerationStore((state) => state.catalog)
  const modelFiles = useImageGenerationStore((state) => state.modelFiles)
  const installed = useImageGenerationStore((state) => state.installedArtifacts)
  const hostBackendId = useImageGenerationStore((state) => state.hostBackendId)
  const engineInstalled = useImageGenerationStore(
    (state) => state.status?.install.state === 'installed'
  )
  const { profile, ready } = useHardwareTier()

  return useMemo(() => {
    if (!PlatformFeatures[PlatformFeature.MEDIA_GENERATION]) return []
    if (!catalog || !ready) return []
    // No build for this host: the Images page explains why; setup offers nothing.
    if (!hostBackendId && !engineInstalled) return []
    return mediaCards(catalog, modelFiles, installed, profile)
  }, [
    catalog,
    modelFiles,
    installed,
    hostBackendId,
    engineInstalled,
    profile,
    ready,
  ])
}

/** How many cards the media step shows; none keeps the step out of the flow. */
export function useMediaCardCount(): number {
  return useMediaCards().length
}
