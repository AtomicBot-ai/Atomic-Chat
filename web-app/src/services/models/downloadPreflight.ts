/**
 * Disk-space check before a model download is queued.
 *
 * The Rust downloader already refuses a transfer the volume cannot hold
 * (`ensure_free_space` in `src-tauri/src/core/downloads/disk.rs`), but that
 * refusal reaches the web as a download *error*: by then every entry point has
 * flipped its row to "Downloading" and the user reads "Not enough disk space"
 * as a failure of something that started. This asks the same questions first,
 * from the sizes the catalog or the download plan declares, so the choke point
 * can decline with nothing moved:
 *
 * - Is there room on the destination's volume for what is left to write, plus
 *   the headroom the downloader keeps (`free_space_headroom`: 2% of the
 *   download, at least 512 MiB)?
 * - Can that volume's file system hold the largest file at all? FAT32 stores
 *   nothing of 4 GiB or more, and catalog files are 8–27 GB.
 *
 * The check is advisory when it cannot tell: an unknown size or an unmeasured
 * volume says "proceed", and the Rust check — which measures the real file —
 * remains the guard. A resume is checked only when its downloaded bytes are
 * known here; otherwise only the downloader knows how much of it counts.
 */

import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import i18n from '@/i18n/setup'
import { route } from '@/constants/routes'
import { isPlatformTauri } from '@/lib/platform/utils'
import { parseFileSizeToBytes } from '@/lib/model-card'
import { formatBytes } from '@/lib/utils'
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

/** Mirrors `DiskSpaceInfo` in `src-tauri/src/core/downloads/volume.rs`. */
export interface DiskSpaceInfo {
  free_bytes: number
  total_bytes: number
  /** `NTFS`, `exFAT`, `FAT32`, …; `null` when the shell cannot tell. */
  fs_name: string | null
  /** `C:\`, `\\server\share\`, a mount point; `null` when unknown. */
  volume_root: string | null
}

export const GET_DISK_SPACE_INFO_COMMAND = 'get_disk_space_info'

/**
 * The volume `path` is on — relative paths resolve against the data folder,
 * which is where every model download is written — or `null` when it cannot
 * be told, a shell that predates the command included.
 */
export async function getDiskSpaceInfo(
  path = '.'
): Promise<DiskSpaceInfo | null> {
  if (!isPlatformTauri()) return null
  try {
    const info = await invoke<DiskSpaceInfo>(GET_DISK_SPACE_INFO_COMMAND, {
      path,
    })
    if (!info || typeof info.free_bytes !== 'number') return null
    return info
  } catch (error) {
    console.debug('[downloadPreflight] destination volume unknown:', error)
    return null
  }
}

/** The floor of the downloader's headroom: `FREE_SPACE_HEADROOM` in `disk.rs`. */
export const MIN_DOWNLOAD_HEADROOM_BYTES = 512 * 1024 * 1024

/**
 * What the downloader keeps free on top of a download of `totalBytes`:
 * `free_space_headroom` in `disk.rs` (2% of it, at least 512 MiB). The same
 * number on both sides, so this check and the downloader never disagree.
 */
export function downloadHeadroomBytes(totalBytes: number): number {
  return Math.max(MIN_DOWNLOAD_HEADROOM_BYTES, Math.floor(totalBytes / 100) * 2)
}

/** The largest file FAT12/16/32 can store: one byte short of 4 GiB. */
export const FAT_MAX_FILE_BYTES = 4 * 1024 ** 3 - 1

/**
 * Whether `fsName` is a FAT variant: Windows' names (as in `disk.rs`), and
 * the `vfat` / `msdos` other systems report. exFAT is not one.
 */
export function isFatFileSystem(fsName: string | null | undefined): boolean {
  return (
    !!fsName &&
    ['fat', 'fat12', 'fat16', 'fat32', 'vfat', 'msdos'].includes(
      fsName.toLowerCase()
    )
  )
}

export interface ExpectedDownload {
  modelPath: string
  mmprojPath?: string
  /** Sizes from Hugging Face metadata, when the caller fetched it. */
  modelSize?: number
  mmprojSize?: number
  /**
   * The largest single file, for the file system's limit. Defaults to the
   * model's size, which for a split model is the sum of its parts.
   */
  largestFileBytes?: number
  /** A resume of a download already partly on disk. */
  resume?: boolean
  /** Bytes of it already downloaded, when known. */
  partialBytes?: number
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
 * The refusal the choke point should return instead of queueing, or
 * `undefined` when the download may proceed (it fits, or nobody can tell).
 */
export async function preflightDownloadDiskSpace(
  download: ExpectedDownload
): Promise<DownloadRefusal | undefined> {
  const partial = Math.max(0, download.partialBytes ?? 0)
  if (download.resume && partial === 0) return undefined
  const size = expectedDownloadBytes(download)
  if (size === undefined) return undefined
  const remaining = Math.max(0, size - partial)

  const volume = await getDiskSpaceInfo()
  if (volume) {
    const largest =
      download.largestFileBytes ??
      download.modelSize ??
      catalogBytesForPath(download.modelPath) ??
      size
    if (isFatFileSystem(volume.fs_name) && largest > FAT_MAX_FILE_BYTES) {
      return {
        kind: 'fs_file_limit',
        fileBytes: largest,
        fsName: volume.fs_name!,
        ...(volume.volume_root ? { volume: volume.volume_root } : {}),
      }
    }
    const needed = remaining + downloadHeadroomBytes(size)
    if (volume.free_bytes >= needed) return undefined
    return {
      kind: 'disk_full',
      needed,
      available: volume.free_bytes,
      ...(volume.volume_root ? { volume: volume.volume_root } : {}),
    }
  }

  // A shell without `get_disk_space_info`: the data folder's drive, as before.
  const space = await getDownloadFreeSpace()
  if (!space || space.available === null) return undefined
  const needed = remaining + space.headroom
  if (space.available >= needed) return undefined
  return { kind: 'disk_full', needed, available: space.available }
}

/**
 * Open Settings → General, where the data folder is moved. Clicks an app link
 * so the router's internal-navigation handler takes it, from code that has no
 * router of its own.
 */
export function openDataFolderSettings(): void {
  const link = document.createElement('a')
  link.href = route.settings.general
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
}

/** The words for a refusal, shared by every entry point that shows one. */
export function describeDownloadRefusal(
  refusal: DownloadRefusal,
  model: string
): { title: string; description: string } {
  if (refusal.kind === 'fs_file_limit') {
    return {
      title: i18n.t('common:toast.downloadFsLimit.title'),
      description: i18n.t('common:toast.downloadFsLimit.description', {
        model,
        size: formatBytes(refusal.fileBytes),
        fsName: refusal.fsName,
        volume:
          refusal.volume ?? i18n.t('common:toast.downloadFsLimit.thisDrive'),
      }),
    }
  }
  return {
    title: i18n.t('common:toast.downloadWontFit.title'),
    description: refusal.volume
      ? i18n.t('common:toast.downloadWontFit.descriptionOnVolume', {
          model,
          needed: formatBytes(refusal.needed),
          available: formatBytes(refusal.available) || '0 B',
          volume: refusal.volume,
        })
      : i18n.t('common:toast.downloadWontFit.description', {
          model,
          needed: formatBytes(refusal.needed),
          available: formatBytes(refusal.available) || '0 B',
        }),
  }
}

/**
 * Say why a download was not queued, with a way to put the data folder on
 * another drive — the one fix for a full or FAT32 drive besides a smaller
 * model.
 */
export function showDownloadRefusalToast(
  refusal: DownloadRefusal,
  model: string
): void {
  const { title, description } = describeDownloadRefusal(refusal, model)
  toast.error(title, {
    id: 'download-wont-fit',
    description,
    duration: 15000,
    action: {
      label: i18n.t('common:toast.downloadWontFit.changeFolder'),
      onClick: openDataFolderSettings,
    },
  })
}
