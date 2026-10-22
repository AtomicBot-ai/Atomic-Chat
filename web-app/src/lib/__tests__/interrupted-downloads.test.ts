import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { localStorageKey } from '@/constants/localStorage'
import {
  useDownloadStore,
  type DownloadProgressProps,
} from '@/hooks/useDownloadStore'
import {
  bindInterruptedDownloads,
  parseInterruptedDownloads,
  persistInterruptedDownloads,
  readInterruptedDownloads,
  restoreInterruptedDownloads,
} from '@/lib/interrupted-downloads'

const CHECKPOINT = 'diffusion-model-z-image_q4_k_m'
const MODEL = 'unsloth/Qwen3-4B-GGUF-Q4_K_M'
const MODEL_URL =
  'https://huggingface.co/unsloth/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf'
const ENGINE = 'llamacpp-backend-b6500/macos-arm64'
const MLX = 'mlx-community/Qwen3-4B-4bit'

const row = (
  id: string,
  progress: number,
  total = 1000
): DownloadProgressProps => ({
  id,
  name: id,
  progress,
  current: Math.round(progress * total),
  total,
  speed: { bytesPerSecond: 0, atBytes: 0, atTime: 0 },
})

const emptyStore = () =>
  useDownloadStore.setState({
    downloads: {},
    localDownloadingModels: new Set(),
    resumableDownloads: new Set(),
    pausedDownloads: new Set(),
    resumeParams: {},
  })

const stored = () => localStorage.getItem(localStorageKey.interruptedDownloads)

/** What a relaunch does: the in-memory store is gone, storage is read again. */
const relaunch = () => {
  emptyStore()
  restoreInterruptedDownloads(readInterruptedDownloads())
}

beforeEach(() => {
  localStorage.removeItem(localStorageKey.interruptedDownloads)
  emptyStore()
})

afterEach(() => {
  localStorage.removeItem(localStorageKey.interruptedDownloads)
})

/**
 * QA 2.2.23 (AC-10): a paused image-model download vanished from the download
 * panel after a relaunch and the picker offered a fresh Download.
 */
describe('interrupted downloads across a relaunch', () => {
  it('brings a paused checkpoint and a running chat model back as paused, resumable rows', () => {
    const stop = persistInterruptedDownloads()
    useDownloadStore.setState({
      downloads: {
        [CHECKPOINT]: row(CHECKPOINT, 0.42),
        [MODEL]: row(MODEL, 0.1),
      },
      pausedDownloads: new Set([CHECKPOINT]),
      resumeParams: {
        [MODEL]: {
          modelPath: MODEL_URL,
          hfToken: 'hf_secret_token',
          skipVerification: true,
          provider: 'llamacpp-upstream',
        },
      },
    })
    // The chat model keeps downloading until the app quits.
    useDownloadStore.getState().updateProgress(MODEL, 0.25, MODEL, 250, 1000)
    stop()

    relaunch()

    const state = useDownloadStore.getState()
    expect(state.downloads[CHECKPOINT]).toMatchObject({
      progress: 0.42,
      current: 420,
      total: 1000,
    })
    expect(state.downloads[MODEL]).toMatchObject({
      progress: 0.25,
      current: 250,
      total: 1000,
    })
    // Nothing runs after a relaunch: both wait for Resume.
    expect([...state.pausedDownloads].sort()).toEqual([CHECKPOINT, MODEL])
    expect(state.resumableDownloads.has(CHECKPOINT)).toBe(true)
    expect(state.resumableDownloads.has(MODEL)).toBe(true)
    expect(state.resumeParams[MODEL]).toEqual({
      modelPath: MODEL_URL,
      skipVerification: true,
      provider: 'llamacpp-upstream',
    })
  })

  it('never writes the Hugging Face token to storage', () => {
    const stop = persistInterruptedDownloads()
    useDownloadStore.setState({
      downloads: { [MODEL]: row(MODEL, 0.5) },
      resumeParams: {
        [MODEL]: { modelPath: MODEL_URL, hfToken: 'hf_secret_token' },
      },
    })
    stop()

    expect(stored()).toContain(MODEL_URL)
    expect(stored()).not.toContain('hf_secret_token')
    // Nor reads one back from a list someone else wrote.
    expect(
      parseInterruptedDownloads(
        JSON.stringify([
          { id: MODEL, resume: { modelPath: MODEL_URL, hfToken: 'hf_x' } },
        ])
      )[0].resume
    ).toEqual({ modelPath: MODEL_URL })
  })

  it('leaves out downloads nothing here could resume', () => {
    const stop = persistInterruptedDownloads()
    useDownloadStore.setState({
      downloads: {
        [ENGINE]: row(ENGINE, 0.3),
        [MLX]: row(MLX, 0.3),
        [CHECKPOINT]: row(CHECKPOINT, 0.3),
      },
    })
    stop()

    relaunch()

    expect(Object.keys(useDownloadStore.getState().downloads)).toEqual([
      CHECKPOINT,
    ])
  })

  it('forgets a download once it finishes or is cancelled', () => {
    const stop = persistInterruptedDownloads()
    useDownloadStore.setState({
      downloads: { [CHECKPOINT]: row(CHECKPOINT, 0.9) },
    })
    expect(stored()).not.toBeNull()

    useDownloadStore.getState().removeDownload(CHECKPOINT)
    stop()

    expect(stored()).toBeNull()
    relaunch()
    expect(useDownloadStore.getState().downloads).toEqual({})
  })

  it('writes progress at most once a percent', () => {
    const stop = persistInterruptedDownloads()
    useDownloadStore.setState({
      downloads: { [CHECKPOINT]: row(CHECKPOINT, 0.1, 100_000) },
    })
    const first = stored()

    // 10.4%: the same percent, so the stored list is not rewritten.
    useDownloadStore
      .getState()
      .updateProgress(CHECKPOINT, 0.104, CHECKPOINT, 10_400, 100_000)
    expect(stored()).toBe(first)

    useDownloadStore
      .getState()
      .updateProgress(CHECKPOINT, 0.11, CHECKPOINT, 11_000, 100_000)
    stop()
    expect(parseInterruptedDownloads(stored())[0]).toMatchObject({
      progress: 0.11,
      current: 11_000,
    })
  })

  it('keeps a download the store already holds as it is', () => {
    localStorage.setItem(
      localStorageKey.interruptedDownloads,
      JSON.stringify([
        {
          id: CHECKPOINT,
          name: CHECKPOINT,
          current: 1,
          total: 10,
          progress: 0.1,
        },
      ])
    )
    useDownloadStore.setState({
      downloads: { [CHECKPOINT]: row(CHECKPOINT, 0.6) },
    })

    restoreInterruptedDownloads(readInterruptedDownloads())

    const state = useDownloadStore.getState()
    expect(state.downloads[CHECKPOINT].progress).toBe(0.6)
    expect(state.pausedDownloads.has(CHECKPOINT)).toBe(false)
  })

  it('ignores a stored list it cannot read', () => {
    expect(parseInterruptedDownloads('not json')).toEqual([])
    expect(parseInterruptedDownloads('{"id":"x"}')).toEqual([])
    expect(
      parseInterruptedDownloads(
        JSON.stringify([
          { name: 'no id' },
          // A chat model without the parameters to resume it with.
          { id: MODEL, progress: 0.5 },
          { id: CHECKPOINT, progress: 7, current: -1 },
        ])
      )
    ).toEqual([
      { id: CHECKPOINT, name: CHECKPOINT, current: 0, total: 0, progress: 1 },
    ])
  })

  it('restores once per app start, then keeps the list', () => {
    localStorage.setItem(
      localStorageKey.interruptedDownloads,
      JSON.stringify([
        {
          id: CHECKPOINT,
          name: CHECKPOINT,
          current: 300,
          total: 1000,
          progress: 0.3,
        },
      ])
    )

    const unbind = bindInterruptedDownloads()
    expect(useDownloadStore.getState().pausedDownloads.has(CHECKPOINT)).toBe(
      true
    )

    // Cancelled from the panel: the list follows.
    useDownloadStore.getState().removeDownload(CHECKPOINT)
    expect(stored()).toBeNull()
    unbind()

    // A second mount in the same session does not bring it back.
    localStorage.setItem(
      localStorageKey.interruptedDownloads,
      JSON.stringify([{ id: CHECKPOINT, progress: 0.3 }])
    )
    emptyStore()
    bindInterruptedDownloads()()
    expect(useDownloadStore.getState().downloads).toEqual({})
  })
})
