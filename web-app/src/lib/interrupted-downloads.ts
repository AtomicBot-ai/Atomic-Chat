/**
 * Model downloads that stopped before they finished — paused, or cut off by
 * quitting the app or a crash — kept across a relaunch.
 *
 * The download store lives in memory, so a relaunch forgot every paused or
 * running download: its row left the download panel and the Downloads page,
 * and the model was offered for a fresh Download (QA 2.2.23, AC-10). The
 * partial files were still on disk — the Rust downloader keeps them for
 * resume — only the record that a download was under way was lost.
 *
 * That record is kept here, in localStorage, for the downloads the panel can
 * resume: chat-model files (with the parameters `pullModelWithMetadata`
 * started them with) and image/video checkpoints (resolved through the
 * catalog). At the next launch they come back as paused, with Resume. The
 * Hugging Face token is never stored; a resume reads it from Settings.
 */

import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'

import { localStorageKey } from '@/constants/localStorage'
import {
  useDownloadStore,
  type DownloadProgressProps,
  type DownloadResumeParams,
  type DownloadState,
} from '@/hooks/useDownloadStore'
import { isDiffusionModelDownloadTaskId } from '@/lib/diffusion/models'
import { newSpeedSample } from '@/lib/downloadFormat'

export type InterruptedDownload = {
  /** The download store key: the model id, or a checkpoint's task id. */
  id: string
  name: string
  current: number
  total: number
  /** 0..1 */
  progress: number
  /** What a chat-model file resumes with; checkpoints resume from the catalog. */
  resume?: Omit<DownloadResumeParams, 'hfToken'>
}

/**
 * The downloads in the store that a relaunch would lose and could resume:
 * running or paused, with resume parameters or a checkpoint task id. Engine
 * builds, MLX repos and the other cancel-only downloads have neither and are
 * resumed from their own cards, from the files on disk.
 */
export function interruptedDownloadsOf(
  state: Pick<DownloadState, 'downloads' | 'resumeParams'>
): InterruptedDownload[] {
  const records: InterruptedDownload[] = []
  for (const [id, entry] of Object.entries(state.downloads)) {
    const params = state.resumeParams[id] ?? state.resumeParams[entry.name]
    if (!params && !isDiffusionModelDownloadTaskId(id)) continue
    const record: InterruptedDownload = {
      id,
      name: entry.name || id,
      current: entry.current ?? 0,
      total: entry.total ?? 0,
      progress: entry.progress ?? 0,
    }
    if (params) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { hfToken: _token, ...resume } = params
      record.resume = resume
    }
    records.push(record)
  }
  return records
}

const finiteOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fallback

/** The stored resume parameters, field by field: nothing else (no token) comes back. */
function parseResume(
  value: unknown
): InterruptedDownload['resume'] | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.modelPath !== 'string' || raw.modelPath === '')
    return undefined
  const resume: NonNullable<InterruptedDownload['resume']> = {
    modelPath: raw.modelPath,
  }
  for (const key of [
    'mmprojPath',
    'provider',
    'modelSha256',
    'mmprojSha256',
  ] as const)
    if (typeof raw[key] === 'string') resume[key] = raw[key] as string
  for (const key of ['modelSize', 'mmprojSize'] as const)
    if (typeof raw[key] === 'number') resume[key] = raw[key] as number
  if (typeof raw.skipVerification === 'boolean')
    resume.skipVerification = raw.skipVerification
  return resume
}

/** Records from storage, the malformed ones dropped. */
export function parseInterruptedDownloads(
  raw: string | null
): InterruptedDownload[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const records: InterruptedDownload[] = []
  for (const value of parsed) {
    if (!value || typeof value !== 'object') continue
    const entry = value as Record<string, unknown>
    if (typeof entry.id !== 'string' || entry.id === '') continue
    const resume = parseResume(entry.resume)
    if (!resume && !isDiffusionModelDownloadTaskId(entry.id)) continue
    records.push({
      id: entry.id,
      name:
        typeof entry.name === 'string' && entry.name ? entry.name : entry.id,
      current: finiteOr(entry.current, 0),
      total: finiteOr(entry.total, 0),
      progress: Math.min(finiteOr(entry.progress, 0), 1),
      ...(resume ? { resume } : {}),
    })
  }
  return records
}

export function readInterruptedDownloads(): InterruptedDownload[] {
  try {
    return parseInterruptedDownloads(
      localStorage.getItem(localStorageKey.interruptedDownloads)
    )
  } catch {
    return []
  }
}

function writeInterruptedDownloads(records: InterruptedDownload[]): void {
  try {
    if (records.length === 0) {
      localStorage.removeItem(localStorageKey.interruptedDownloads)
    } else {
      localStorage.setItem(
        localStorageKey.interruptedDownloads,
        JSON.stringify(records)
      )
    }
  } catch (error) {
    console.warn('[downloads] could not record interrupted downloads:', error)
  }
}

/**
 * Put the records back in the store as paused downloads the panel can resume.
 * Nothing is running after a relaunch, so every one of them is paused; a
 * download the store already holds is left as it is.
 */
export function restoreInterruptedDownloads(
  records: readonly InterruptedDownload[]
): void {
  if (records.length === 0) return
  useDownloadStore.setState((state) => {
    const downloads = { ...state.downloads }
    const pausedDownloads = new Set(state.pausedDownloads)
    const resumableDownloads = new Set(state.resumableDownloads)
    const resumeParams = { ...state.resumeParams }
    for (const record of records) {
      if (record.id in downloads) continue
      const entry: DownloadProgressProps = {
        id: record.id,
        name: record.name,
        progress: record.progress,
        current: record.current,
        total: record.total,
        speed: newSpeedSample(record.current),
      }
      downloads[record.id] = entry
      for (const key of new Set([record.id, record.name])) {
        pausedDownloads.add(key)
        resumableDownloads.add(key)
      }
      if (record.resume) resumeParams[record.id] = { ...record.resume }
    }
    return { downloads, pausedDownloads, resumableDownloads, resumeParams }
  })
}

/**
 * What changes the stored list: a download added or gone, whether it can be
 * resumed with parameters, and its progress to the percent. Progress events
 * arrive many times a second; the list is written at most once a percent.
 */
const signatureOf = (records: readonly InterruptedDownload[]): string =>
  records
    .map((record) =>
      [
        record.id,
        Math.floor(record.progress * 100),
        record.resume ? 1 : 0,
      ].join('|')
    )
    .join('\n')

/** Keep the stored list in step with the store; returns the unsubscribe. */
export function persistInterruptedDownloads(): () => void {
  let last = signatureOf(interruptedDownloadsOf(useDownloadStore.getState()))
  return useDownloadStore.subscribe((state) => {
    const records = interruptedDownloadsOf(state)
    const signature = signatureOf(records)
    if (signature === last) return
    last = signature
    writeInterruptedDownloads(records)
  })
}

/**
 * Only the main window keeps the list. A chat opened in its own window runs a
 * store of its own, which would bring the same downloads back a second time
 * and write its stale copy over the main window's.
 */
function isMainWindow(): boolean {
  try {
    return getCurrentWebviewWindow().label === 'main'
  } catch {
    // No Tauri window (the web build, tests): there is only the one.
    return true
  }
}

let restored = false

/**
 * Bring back what the last session left unfinished, once per app start, and
 * keep the list from then on. Bound by the download panel, which is mounted
 * once at the root.
 */
export function bindInterruptedDownloads(): () => void {
  if (!isMainWindow()) return () => {}
  if (!restored) {
    restored = true
    restoreInterruptedDownloads(readInterruptedDownloads())
  }
  return persistInterruptedDownloads()
}
