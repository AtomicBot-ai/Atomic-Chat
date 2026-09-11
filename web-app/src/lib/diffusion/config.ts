/**
 * Where local image generation keeps its files, and the one-time plugin
 * configuration that tells the native side the same thing.
 *
 * Layout under the app data folder (approved paths, see DEVELOP.md):
 *
 *   <dataFolder>/diffusion/backends/<tag>/<backendId>/   sd-server + libs
 *   <dataFolder>/diffusion/models/<family>/<file>         transformers
 *   <dataFolder>/diffusion/models/shared/<repo>/<file>    VAEs, text encoders
 *   <dataFolder>/images/                                  gallery PNGs
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

export type DiffusionPaths = {
  dataFolder: string
  modelsRoot: string
  backendsRoot: string
  imagesDir: string
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
 * Bind the plugin to the data folder. Idempotent; call it once when the
 * Images provider mounts and again after the data folder is relocated.
 */
export async function configureDiffusion(
  overrides: { outputDir?: string; idleUnloadSecs?: number } = {}
): Promise<DiffusionStatus> {
  const { dataFolder } = await getDiffusionPaths()
  return getServiceHub()
    .diffusion()
    .configure({
      dataFolder,
      ...(overrides.outputDir ? { outputDir: overrides.outputDir } : {}),
      ...(overrides.idleUnloadSecs !== undefined
        ? { idleUnloadSecs: overrides.idleUnloadSecs }
        : {}),
    })
}
