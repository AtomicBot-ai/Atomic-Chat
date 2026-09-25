/**
 * Where local image generation keeps its files, and the configuration that
 * tells the core the same thing.
 *
 * Layout under the app data folder (approved paths, see DEVELOP.md):
 *
 *   <dataFolder>/diffusion/backends/<tag>/<backendId>/   sd-server + libs
 *   <dataFolder>/diffusion/models/<family>/<file>         transformers
 *   <dataFolder>/diffusion/models/shared/<repo>/<file>    VAEs, text encoders
 *   <dataFolder>/images/                                  gallery PNGs
 *   <dataFolder>/videos/                                  gallery WebMs with their JSON recipes
 *
 * Image checkpoints never live under `llamacpp/models`: they are not chat
 * models and must not surface in the Hub or in `/v1/models`.
 */

import { getJanDataFolderPath } from '@janhq/core'

import { getServiceHub, isServiceHubInitialized } from '@/hooks/useServiceHub'
import type { DiffusionStatus } from '@/services/diffusion/types'

export const DIFFUSION_DIR = 'diffusion'
export const DIFFUSION_BACKENDS_DIR = 'backends'
export const DIFFUSION_MODELS_DIR = 'models'
export const DIFFUSION_SHARED_DIR = 'shared'
export const IMAGES_DIR = 'images'
export const VIDEOS_DIR = 'videos'

export type DiffusionPaths = {
  dataFolder: string
  modelsRoot: string
  backendsRoot: string
  imagesDir: string
  videosDir: string
}

/**
 * The separator the data folder itself uses. Rust accepts `/` inside an
 * absolute Windows path, but the plugin compares paths textually
 * (`starts_with(models_root)`), so a mixed path would fail its containment
 * check even though the OS would open it.
 */
export function pathSeparatorOf(base: string): '/' | '\\' {
  return base.includes('\\') && !base.includes('/') ? '\\' : '/'
}

/** Join path segments below `base` with `base`'s own separator; `/` inside a segment is re-split. */
export function joinDiffusionPath(base: string, ...segments: string[]): string {
  const separator = pathSeparatorOf(base)
  const parts = [base.replace(/[\\/]+$/, '')]
  for (const segment of segments) {
    for (const piece of segment.split(/[\\/]+/)) {
      if (piece.length > 0) parts.push(piece)
    }
  }
  return parts.join(separator)
}

/** Pure: the layout for a given data folder. */
export function diffusionPathsFor(dataFolder: string): DiffusionPaths {
  return {
    dataFolder,
    modelsRoot: joinDiffusionPath(dataFolder, DIFFUSION_DIR, DIFFUSION_MODELS_DIR),
    backendsRoot: joinDiffusionPath(
      dataFolder,
      DIFFUSION_DIR,
      DIFFUSION_BACKENDS_DIR
    ),
    imagesDir: joinDiffusionPath(dataFolder, IMAGES_DIR),
    videosDir: joinDiffusionPath(dataFolder, VIDEOS_DIR),
  }
}

async function resolveDataFolder(): Promise<string> {
  let dataFolder: string | undefined
  if (isServiceHubInitialized()) {
    try {
      dataFolder = await getServiceHub().app().getJanDataFolder()
    } catch {
      dataFolder = undefined
    }
  }
  if (!dataFolder) {
    try {
      dataFolder = await getJanDataFolderPath()
    } catch {
      dataFolder = undefined
    }
  }
  if (!dataFolder) {
    throw new Error('The app data folder is not configured yet.')
  }
  return dataFolder
}

export async function getDiffusionPaths(): Promise<DiffusionPaths> {
  return diffusionPathsFor(await resolveDataFolder())
}

/**
 * Configure the core's image generation: the data folder plus the settings
 * the core keeps only in memory. Each call replaces the core's whole
 * configuration, and an absent `outputDir` means `<dataFolder>/images`, so a
 * caller passes every setting it wants kept; the image-generation store does,
 * when it binds, on a new core attachment and after a setting changes.
 */
export async function configureDiffusion(
  overrides: {
    outputDir?: string
    videoOutputDir?: string
    idleUnloadSecs?: number
  } = {}
): Promise<DiffusionStatus> {
  const { dataFolder } = await getDiffusionPaths()
  return getServiceHub()
    .diffusion()
    .configure({
      dataFolder,
      ...(overrides.outputDir ? { outputDir: overrides.outputDir } : {}),
      ...(overrides.videoOutputDir
        ? { videoOutputDir: overrides.videoOutputDir }
        : {}),
      ...(overrides.idleUnloadSecs !== undefined
        ? { idleUnloadSecs: overrides.idleUnloadSecs }
        : {}),
    })
}
