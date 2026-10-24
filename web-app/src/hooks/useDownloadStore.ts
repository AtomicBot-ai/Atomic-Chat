import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { restoreDownloadRecovery, saveDownloadRecovery, type DownloadRecovery } from '@/lib/downloadRecovery'
import {
  advanceSpeedSample,
  newSpeedSample,
  type SpeedSample,
} from '@/lib/downloadFormat'
import type { PullModelOptions } from '@/services/models/types'

/** Ephemeral requests from Downloads; the app-wide manager owns their lifecycle. */
export type DownloadControlRequest = {
  requestId: number
  action: 'pause' | 'resume' | 'cancel'
  id: string
  name: string
}
let nextControlRequest = 0

/**
 * What the Rust downloader is doing while it has no bytes to report. Mirrors
 * `DownloadStage` in `src-tauri/src/core/downloads/models.rs`, relayed by the
 * download extension.
 */
export interface DownloadStage {
  kind: string
  attempt: number
  maxAttempts: number
}

export interface DownloadProgressProps {
  id: string
  progress: number
  name: string
  current: number
  total: number
  /** A discovered partial is visible even when its source metadata cannot be trusted. */
  recoveryBlocked?: 'missing_source' | 'invalid_manifest' | 'source_conflict' | 'installed_model' | 'unsupported_layout'
  // ATO — #290: a transfer that cannot reach the host spends ~60s inside the
  // retry ladders with no bytes and no events, which rendered as a permanent
  // "Preparing". The stage is the only thing the row can show in that window.
  stage?: DownloadStage
  // ATO-462: speed and ETA are the two numbers the panel needs and the app
  // never had. They live here rather than in the panel so the Hub card, the
  // onboarding screen and the panel all quote the same figure, and so the
  // estimate survives the panel being collapsed or unmounted.
  speed: SpeedSample
  /**
   * The first byte count this run reported, and when. The terminal
   * `model_download` event derives the run's average speed from it: the
   * smoothed `speed` is reset by every stall and says nothing about the run.
   */
  transferStart?: { bytes: number; time: number }
  /** Times the transfer went quiet (`stalled`), for the terminal event. */
  stalls?: number
  /** Reconnect attempts reported (`retrying`), for the terminal event. */
  retries?: number
}

// ATO-154: parameters needed to resume a paused model download from the
// global Download popover. The popover only knows the model id, not the HF
// paths/token, so the download-start choke point (`pullModelWithMetadata`)
// records them here. Only the resumable GGUF (`llamacpp`) path stores these;
// MLX (`mlx-community/*`) and backend-binary downloads are pause/resume-gated
// out and never populate this map.
/** What a paused download resumes with; `provider` and the hashes as the pull was given them. */
export interface DownloadResumeParams extends PullModelOptions {
  modelPath: string
  mmprojPath?: string
  hfToken?: string
  skipVerification?: boolean
}

/**
 * Why a text-model download was started.
 *
 * A download is passive unless a blocked Send explicitly adopts it. Keeping
 * this separate from `downloadOriginByModelId` is intentional: that map names
 * the Hugging Face card/repository for collision handling, while this map
 * carries the user intent that is allowed to select/start the model later.
 */
export type DownloadRequestOrigin =
  | 'standalone'
  | 'reply-gate'
  /** The first-run flow's chat model; its own runtime selects it when ready. */
  | 'onboarding'

// Zustand store for thinking block state
export type DownloadState = {
  downloads: { [id: string]: DownloadProgressProps }
  localDownloadingModels: Set<string>
  resumableDownloads: Set<string>
  // Maps a raw `quant.model_id` to the `model.model_name` of the Hub
  // card that initiated the download. Used as a defensive disambiguator
  // when the curated catalog accidentally emits the same `quant.model_id`
  // for files of identical name living in different HF repos
  // (e.g. `unsloth/Qwen3.5-4B-GGUF` and `unsloth/Qwen3.5-4B-MTP-GGUF`).
  // Without this map both Hub cards react to the same progress events
  // and look like they are both being downloaded. The catalog scraper
  // fixes the root cause; this map keeps the UI honest for clients on
  // an older cached catalog.
  downloadOriginByModelId: { [modelId: string]: string }
  downloadRequestOriginByModelId: {
    [modelId: string]: DownloadRequestOrigin
  }
  // ATO-154: ids the user has paused (vs cancelled). A paused id keeps its
  // `downloads[id]` entry so the popover row survives, and makes the
  // stop/error listeners early-return instead of cleaning up.
  pausedDownloads: Set<string>
  /** Explicit Cancel hides a job across restarts without deleting its files. */
  dismissedDownloads: Set<string>
  dismissDownload: (id: string) => void
  clearDismissedDownload: (id: string) => void
  // ATO-154: resume parameters keyed by model id (see DownloadResumeParams).
  resumeParams: { [modelId: string]: DownloadResumeParams }
  controlRequests: DownloadControlRequest[]
  requestControl: (action: DownloadControlRequest['action'], download: { id: string; name: string }) => void
  takeControlRequest: (requestId: number) => boolean
  removeDownload: (id: string) => void
  updateProgress: (
    id: string,
    progress: number,
    name?: string,
    current?: number,
    total?: number
  ) => void
  updateStage: (id: string, stage: DownloadStage) => void
  addLocalDownloadingModel: (modelId: string) => void
  removeLocalDownloadingModel: (modelId: string) => void
  markResumableDownload: (modelId: string) => void
  clearResumableDownload: (modelId: string) => void
  markPausedDownload: (modelId: string) => void
  clearPausedDownload: (modelId: string) => void
  setResumeParams: (modelId: string, params: DownloadResumeParams) => void
  clearResumeParams: (modelId: string) => void
  setDownloadOrigin: (
    modelId: string,
    modelName: string,
    requestOrigin?: DownloadRequestOrigin
  ) => void
  setDownloadRequestOrigin: (
    modelId: string,
    requestOrigin: DownloadRequestOrigin
  ) => void
  clearDownloadOrigin: (modelId: string) => void
}

/**
 * This store is used to manage the download progress of files.
 */
export const useDownloadStore = create<DownloadState>()(persist<DownloadState, [], [], { recovery: DownloadRecovery }>((set) => ({
  controlRequests: [],
  requestControl: (action, download) => set((state) => {
    if (state.controlRequests.some((request) => request.id === download.id && request.action === action)) return state
    return { controlRequests: [...state.controlRequests, { ...download, action, requestId: ++nextControlRequest }] }
  }),
  takeControlRequest: (requestId) => {
    let taken = false
    set((state) => {
      if (state.controlRequests[0]?.requestId !== requestId) return state
      taken = true
      return { controlRequests: state.controlRequests.slice(1) }
    })
    return taken
  },
  downloads: {},
  localDownloadingModels: new Set(),
  resumableDownloads: new Set(),
  pausedDownloads: new Set(),
  dismissedDownloads: new Set(),
  dismissDownload: (id) => set((state) => {
    const downloads = { ...state.downloads }
    delete downloads[id]
    const pausedDownloads = new Set(state.pausedDownloads)
    const localDownloadingModels = new Set(state.localDownloadingModels)
    pausedDownloads.delete(id)
    localDownloadingModels.delete(id)
    return { downloads, pausedDownloads, localDownloadingModels,
      dismissedDownloads: new Set(state.dismissedDownloads).add(id) }
  }),
  clearDismissedDownload: (id) => set((state) => {
    const dismissedDownloads = new Set(state.dismissedDownloads)
    dismissedDownloads.delete(id)
    return { dismissedDownloads }
  }),
  resumeParams: {},
  downloadOriginByModelId: {},
  downloadRequestOriginByModelId: {},
  removeDownload: (id: string) =>
    set((state) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [id]: _, ...rest } = state.downloads
      return { downloads: rest }
    }),

  updateProgress: (id, progress, name, current, total) =>
    set((state) => {
      if (state.dismissedDownloads.has(id)) return state
      const previous = state.downloads[id]
      // `??` (not `||`) so explicit zero values — e.g. a restarted or
      // resumed transfer whose byte counter resets to 0 — are honored
      // instead of being replaced by the stale previous value.
      const nextCurrent = current ?? previous?.current ?? 0
      const transferStart =
        previous?.transferStart && nextCurrent >= previous.transferStart.bytes
          ? previous.transferStart
          : { bytes: nextCurrent, time: Date.now() }
      return {
        downloads: {
          ...state.downloads,
          [id]: {
            ...previous,
            name: name ?? previous?.name ?? '',
            progress,
            current: nextCurrent,
            total: total ?? previous?.total ?? 0,
            speed: advanceSpeedSample(previous?.speed, nextCurrent),
            transferStart,
            // Bytes moved, so whatever the ladder was reporting is stale.
            stage: undefined,
          },
        },
      }
    }),

  // A stage update is a status change, never progress: it must not touch
  // `current`/`total`, or a retry would rewind the bar to zero.
  updateStage: (id, stage) =>
    set((state) => {
      if (state.dismissedDownloads.has(id)) return state
      const previous = state.downloads[id]
      const current = previous?.current ?? 0
      // No bytes are moving while the downloader waits on a quiet connection
      // or a reconnect. Keeping the last estimate made the panel quote a live
      // speed and a frozen ETA for a transfer that had stopped (field
      // feedback, 2026-09-29); dropping it hides the ETA until bytes flow and
      // the estimate restarts from the new rate.
      const idle = stage.kind === 'stalled' || stage.kind === 'retrying'
      const newStall =
        stage.kind === 'stalled' && previous?.stage?.kind !== 'stalled'
      return {
        downloads: {
          ...state.downloads,
          [id]: {
            ...previous,
            // A stage can come first (the preflight ladder runs before any
            // byte): name the row after its id, as `updateProgress` callers
            // do, so the panel labels it and routes its Cancel by that id.
            name: previous?.name ?? id,
            progress: previous?.progress ?? 0,
            current,
            total: previous?.total ?? 0,
            speed: idle
              ? newSpeedSample(current)
              : advanceSpeedSample(previous?.speed, current),
            stalls: (previous?.stalls ?? 0) + (newStall ? 1 : 0),
            retries:
              (previous?.retries ?? 0) + (stage.kind === 'retrying' ? 1 : 0),
            stage,
          },
        },
      }
    }),

  addLocalDownloadingModel: (modelId: string) =>
    set((state) => ({
      localDownloadingModels: new Set(state.localDownloadingModels).add(
        modelId
      ),
    })),

  removeLocalDownloadingModel: (modelId: string) =>
    set((state) => {
      const newSet = new Set(state.localDownloadingModels)
      newSet.delete(modelId)
      return { localDownloadingModels: newSet }
    }),

  markResumableDownload: (modelId: string) =>
    set((state) => ({
      resumableDownloads: new Set(state.resumableDownloads).add(modelId),
    })),

  clearResumableDownload: (modelId: string) =>
    set((state) => {
      const newSet = new Set(state.resumableDownloads)
      newSet.delete(modelId)
      return { resumableDownloads: newSet }
    }),

  markPausedDownload: (modelId: string) =>
    set((state) => ({
      pausedDownloads: new Set(state.pausedDownloads).add(modelId),
    })),

  clearPausedDownload: (modelId: string) =>
    set((state) => {
      const newSet = new Set(state.pausedDownloads)
      newSet.delete(modelId)
      return { pausedDownloads: newSet }
    }),

  setResumeParams: (modelId: string, params: DownloadResumeParams) =>
    set((state) => ({
      resumeParams: {
        ...state.resumeParams,
        [modelId]: params,
      },
    })),

  clearResumeParams: (modelId: string) =>
    set((state) => {
      if (!(modelId in state.resumeParams)) {
        return state
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [modelId]: _, ...rest } = state.resumeParams
      return { resumeParams: rest }
    }),

  setDownloadOrigin: (
    modelId: string,
    modelName: string,
    requestOrigin: DownloadRequestOrigin = 'standalone'
  ) =>
    set((state) => ({
      downloadOriginByModelId: {
        ...state.downloadOriginByModelId,
        [modelId]: modelName,
      },
      downloadRequestOriginByModelId: {
        ...state.downloadRequestOriginByModelId,
        [modelId]: requestOrigin,
      },
    })),

  // A Send may intentionally adopt a transfer that was already running from
  // the Hub/reminder. That is the only promotion from passive to reply-gated.
  setDownloadRequestOrigin: (modelId, requestOrigin) =>
    set((state) => ({
      downloadRequestOriginByModelId: {
        ...state.downloadRequestOriginByModelId,
        [modelId]: requestOrigin,
      },
    })),

  clearDownloadOrigin: (modelId: string) =>
    set((state) => {
      if (
        !(modelId in state.downloadOriginByModelId) &&
        !(modelId in state.downloadRequestOriginByModelId)
      ) {
        return state
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [modelId]: _, ...rest } = state.downloadOriginByModelId
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [modelId]: __, ...requestOrigins } =
        state.downloadRequestOriginByModelId
      return {
        downloadOriginByModelId: rest,
        downloadRequestOriginByModelId: requestOrigins,
      }
    }),
}), {
  name: 'atomic-model-downloads-v1',
  storage: createJSONStorage(() => ({
    // Storage may be unavailable or full; recovery must never stop a live transfer.
    getItem: (name) => { try { return localStorage.getItem(name) } catch { return null } },
    setItem: (name, value) => { try { localStorage.setItem(name, value) } catch { /* Best effort journal. */ } },
    removeItem: (name) => { try { localStorage.removeItem(name) } catch { /* Storage is unavailable. */ } },
  })),
  partialize: (state) => ({ recovery: saveDownloadRecovery(state) }),
  merge: (saved, current) => ({
    ...current,
    ...restoreDownloadRecovery((saved as { recovery?: unknown } | undefined)?.recovery),
  }),
}))
