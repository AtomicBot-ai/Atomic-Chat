/**
 * File transfer for diffusion downloads — backend archives and checkpoints.
 *
 * Both go through the ordinary `download-extension` pipeline so the standard
 * download panel, the proxy setting and the Rust size/sha256 verification all
 * apply unchanged. What differs from a chat-model download is only the task id
 * and the save path, which is why this is a thin wrapper and not an engine.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { DownloadEvent, events } from '@janhq/core'

import { useProxyConfig } from '@/hooks/useProxyConfig'

/** What the Rust `download_files` command accepts per file. */
export type TransferItem = {
  url: string
  save_path: string
  proxy?: Record<string, string | string[] | boolean>
  sha256?: string
  size?: number
  /** Surfaces in the validation toasts; keep it equal to the panel's row id. */
  model_id?: string
}

export type TransferProgress = (transferred: number, total: number) => void

type DownloadManagerLike = {
  downloadFiles?: (
    items: TransferItem[],
    taskId: string,
    onProgress?: TransferProgress,
    resume?: boolean
  ) => Promise<void>
  cancelDownload?: (taskId: string) => Promise<void>
}

export const DOWNLOAD_EXTENSION_NAME = '@janhq/download-extension'

// Hosts that may receive the Hugging Face access token. Mirrors
// `HF_AUTH_HOSTS` in extensions/download-extension: sending the token to any
// other host makes that host answer 401.
const HF_AUTH_HOSTS: readonly string[] = ['huggingface.co', 'hf.co']

export function isHfHost(url: string): boolean {
  try {
    const host = new URL(url).host.toLowerCase()
    return HF_AUTH_HOSTS.some(
      (allowed) => host === allowed || host.endsWith(`.${allowed}`)
    )
  } catch {
    return false
  }
}

/**
 * The task id is embedded in a Tauri event name (`download-${taskId}`), and
 * Tauri accepts only `[A-Za-z0-9_/:-]` there. Family ids carry dots
 * (`flux.1`), release tags carry dots and hashes; collapse everything else.
 */
export function sanitizeTaskId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_')
}

export function getDownloadManager(): DownloadManagerLike | undefined {
  return window.core?.extensionManager?.getByName(DOWNLOAD_EXTENSION_NAME) as
    | DownloadManagerLike
    | undefined
}

/**
 * The proxy the Rust downloader should route through (Settings → Proxy),
 * in the shape `download_files` expects. Mirrors `getProxyConfig` in the
 * llama.cpp extensions, which the web app cannot import.
 */
export function downloadProxyConfig():
  | Record<string, string | string[] | boolean>
  | undefined {
  const state = useProxyConfig.getState()
  if (!state.proxyEnabled || !state.proxyUrl) return undefined
  const proxy: Record<string, string | string[] | boolean> = {
    url: state.proxyUrl,
  }
  if (state.proxyUsername && state.proxyPassword) {
    proxy.username = state.proxyUsername
    proxy.password = state.proxyPassword
  }
  const noProxy = state.noProxy
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  if (noProxy.length > 0) proxy.no_proxy = noProxy
  proxy.ignore_ssl = state.proxyIgnoreSSL
  proxy.verify_proxy_ssl = state.verifyProxySSL
  proxy.verify_proxy_host_ssl = state.verifyProxyHostSSL
  proxy.verify_peer_ssl = state.verifyPeerSSL
  proxy.verify_host_ssl = state.verifyHostSSL
  return proxy
}

/** Progress payload the download panel and `useDownloadStore` consume. */
export function emitTransferProgress(
  id: string,
  downloadType: 'Model' | 'Backend',
  transferred: number,
  total: number
): void {
  events.emit(DownloadEvent.onFileDownloadUpdate, {
    modelId: id,
    percent: total > 0 ? transferred / total : 0,
    size: { transferred, total },
    downloadType,
  })
}

export function emitTransferSuccess(
  id: string,
  downloadType: 'Model' | 'Backend',
  totalBytes: number
): void {
  events.emit(DownloadEvent.onFileDownloadSuccess, {
    modelId: id,
    downloadType,
    size: { transferred: totalBytes, total: totalBytes },
  })
}

export function emitTransferError(
  id: string,
  downloadType: 'Model' | 'Backend',
  error: unknown
): void {
  events.emit(DownloadEvent.onFileDownloadError, {
    modelId: id,
    downloadType,
    error: error instanceof Error ? error.message : String(error),
  })
}

export type TransferOptions = {
  onProgress?: TransferProgress
  resume?: boolean
  /**
   * Explicit Hugging Face token. When given, the transfer bypasses the
   * extension's own token setting and attaches this one — only if every URL
   * in the batch is a Hugging Face host, exactly like the extension does.
   */
  hfToken?: string
}

async function rawTransfer(
  items: TransferItem[],
  taskId: string,
  headers: Record<string, string>,
  options: TransferOptions
): Promise<void> {
  const unlisten = await listen<{ transferred: number; total: number }>(
    `download-${taskId}`,
    (event) => options.onProgress?.(event.payload.transferred, event.payload.total)
  )
  try {
    await invoke<void>('download_files', {
      items,
      taskId,
      headers,
      resume: options.resume ?? false,
    })
  } finally {
    unlisten()
  }
}

/** Download `items` under `taskId`; resolves once every file is on disk and verified. */
export async function transferFiles(
  items: TransferItem[],
  taskId: string,
  options: TransferOptions = {}
): Promise<void> {
  if (options.hfToken) {
    const allHf = items.every((item) => isHfHost(item.url))
    const headers: Record<string, string> = allHf
      ? { Authorization: `Bearer ${options.hfToken}` }
      : {}
    await rawTransfer(items, taskId, headers, options)
    return
  }
  const manager = getDownloadManager()
  if (manager?.downloadFiles) {
    await manager.downloadFiles(
      items,
      taskId,
      options.onProgress,
      options.resume ?? false
    )
    return
  }
  await rawTransfer(items, taskId, {}, options)
}

export async function cancelTransfer(taskId: string): Promise<void> {
  const manager = getDownloadManager()
  if (manager?.cancelDownload) {
    await manager.cancelDownload(taskId)
    return
  }
  await invoke<void>('cancel_download_task', { taskId })
}
