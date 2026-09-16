/**
 * Disk-space check before a model download starts.
 *
 * The Rust downloader already refuses a transfer the volume cannot hold
 * (`ensure_free_space` in `src-tauri/src/core/downloads/disk.rs`), but that
 * refusal reaches the web as a download *error*: by then every entry point has
 * flipped its row to "Downloading" and the user reads "Not enough disk space"
 * as a failure of something that started. This asks the same question first,
 * from the sizes the catalog already declares, so the choke point can decline
 * with nothing moved.
 *
 * The check is advisory: when the size or the free space is unknown it says
 * "proceed", and the Rust check — which measures the real file — remains the
 * guard. A resume is never second-guessed here: its partial is already on
 * disk and only the downloader knows how much of it counts.
 */

import { invoke } from '@tauri-apps/api/core'
import { isPlatformTauri } from '@/lib/platform/utils'
import { parseFileSizeToBytes } from '@/lib/model-card'
import { useModelSources } from '@/hooks/useModelSources'
import type { DownloadRefusal } from './types'

/** Mirrors `FreeSpaceReport` in `src-tauri/src/core/downloads/disk.rs`. */
export interface FreeSpaceReport {
  /** Free bytes on the volume holding the data folder; `null` when unknown. */
  available: number | null
  /** Bytes the downloader keeps free on top of the files themselves. */
  headroom: number
}

export const GET_DOWNLOAD_FREE_SPACE_COMMAND = 'get_download_free_space'

/** Free space on the drive holding the data folder, or `null` if it cannot be told. */
export async function getDownloadFreeSpace(): Promise<FreeSpaceReport | null> {
  if (!isPlatformTauri()) return null
  try {
    const report = await invoke<FreeSpaceReport>(
      GET_DOWNLOAD_FREE_SPACE_COMMAND
    )
    if (!report || typeof report.headroom !== 'number') return null
    return report
  } catch (error) {
    console.warn('[downloadPreflight] free space unknown:', error)
    return null
  }
}

export interface ExpectedDownload {
  modelPath: string
  mmprojPath?: string
  /** Sizes from Hugging Face metadata, when the caller fetched it. */
  modelSize?: number
  mmprojSize?: number
}

/** The catalog's declared size for a file URL, if the catalog lists it. */
function catalogBytesForPath(path: string): number | undefined {
  for (const entry of useModelSources.getState().sources) {
    const file =
      entry.quants?.find((quant) => quant.path === path) ??
      entry.mmproj_models?.find((mmproj) => mmproj.path === path)
    if (file) return parseFileSizeToBytes(file.file_size)
  }
  return undefined
}

/**
 * Bytes the download will write, or `undefined` when nothing declares the
 * model's size. An mmproj of unknown size is left out rather than blocking the
 * estimate: the model is the bulk, and the Rust check still covers the rest.
 */
export function expectedDownloadBytes(
  download: ExpectedDownload
): number | undefined {
  const model = download.modelSize ?? catalogBytesForPath(download.modelPath)
  if (model === undefined) return undefined
  if (!download.mmprojPath) return model
  const mmproj = download.mmprojSize ?? catalogBytesForPath(download.mmprojPath)
  return mmproj === undefined ? model : model + mmproj
}

/**
 * The refusal the choke point should return instead of starting, or
 * `undefined` when the download may proceed (it fits, or nobody can tell).
 */
export async function preflightDownloadDiskSpace(
  download: ExpectedDownload
): Promise<DownloadRefusal | undefined> {
  const size = expectedDownloadBytes(download)
  if (size === undefined) return undefined
  const space = await getDownloadFreeSpace()
  if (!space || space.available === null) return undefined
  const needed = size + space.headroom
  if (space.available >= needed) return undefined
  return { kind: 'disk_full', needed, available: space.available }
}
