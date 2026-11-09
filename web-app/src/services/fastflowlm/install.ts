import { DownloadEvent, events } from '@janhq/core'
import type { DownloadStage } from '@/hooks/useDownloadStore'
import {
  isFastFlowLmInstallFinished,
  type FastFlowLmInstallState,
} from '@/lib/fastflowlm/install-state'
import { invoke } from '@tauri-apps/api/core'
import {
  buildFastFlowLmConfig,
  parseFastFlowLmDescriptor,
} from '@atomic-chat/core/client'
import type { FastFlowLmDefinition } from '@atomic-chat/core/contracts'
import { listen } from '@tauri-apps/api/event'
import {
  downloadProxyConfig,
  emitTransferError,
  emitTransferSuccess,
  emitTransferProgress,
} from '@/services/diffusion/transfer'
import { fastFlowLmDownloadId } from '@/lib/fastflowlm/download-id'
export { fastFlowLmDownloadId } from '@/lib/fastflowlm/download-id'

/** Matches serde_json's ordered object keys, so the native installer verifies the same descriptor digest. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)])
    )
  return value
}

export async function prepareFastFlowLmInstall(
  model: FastFlowLmDefinition,
  requestId: string
) {
  const descriptor = parseFastFlowLmDescriptor(model)
  const config = buildFastFlowLmConfig(descriptor)
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(canonical(descriptor)))
  )
  return {
    schema_version: 1 as const,
    request_id: requestId,
    name: model.name,
    descriptor,
    config,
    digest: Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join(''),
    total_bytes: descriptor.files.reduce((sum, file) => sum + file.size, 0),
  }
}

export interface FastFlowLmInstallJob {
  model_id: string
  state: FastFlowLmInstallState
  maintenance_completed?: boolean
  plan: Awaited<ReturnType<typeof prepareFastFlowLmInstall>>
  running?: boolean
}
let listing: Promise<FastFlowLmInstallJob[]> | undefined
export function fastFlowLmInstallJobs() {
  if (listing) return listing
  const pending = invoke<FastFlowLmInstallJob[]>(
    'atomic_fastflowlm_install_jobs'
  )
  listing = pending
  void pending
    .finally(() => {
      if (listing === pending) listing = undefined
    })
    .catch(() => {})
  return pending
}

/** Resume knows the original variant through its journal, even if conf no longer lists it. */
export async function resumeFastFlowLmDownload(taskId: string, token?: string) {
  const job = (await fastFlowLmInstallJobs()).find(
    (entry) => fastFlowLmDownloadId(entry.model_id) === taskId
  )
  if (!job)
    throw new Error(
      'The saved FastFlowLM download plan was not found; partial files were kept.'
    )
  await running.get(job.model_id)?.catch(() => {})
  return installFastFlowLm(
    { ...job.plan.descriptor, name: job.plan.name } as FastFlowLmDefinition,
    token
  )
}

const running = new Map<string, Promise<void>>()
/** Native download and publication survive a panel unmount. Resume rereads the on-disk plan first. */
export function installFastFlowLm(
  model: FastFlowLmDefinition,
  token?: string,
  onProgress?: (current: number, total: number) => void
): Promise<void> {
  const id = model.variant_id
  const pending = running.get(id)
  if (pending) return pending
  const taskId = fastFlowLmDownloadId(id)
  const work = (async () => {
    const saved = (await fastFlowLmInstallJobs()).find(
      (job) => job.model_id === id && !isFastFlowLmInstallFinished(job)
    )
    const plan =
      saved?.plan ??
      (await prepareFastFlowLmInstall(model, crypto.randomUUID()))
    const unlisten = await listen<{
      transferred: number
      total: number
      stage?: DownloadStage
    }>(`download-${taskId}`, ({ payload }) => {
      if (payload.stage) {
        events.emit(DownloadEvent.onFileDownloadUpdate, {
          modelId: taskId,
          downloadType: 'Model',
          stage: payload.stage,
        })
        return
      }
      onProgress?.(payload.transferred, payload.total)
      emitTransferProgress(taskId, 'Model', payload.transferred, payload.total)
    })
    try {
      await invoke('atomic_fastflowlm_install_model', {
        modelId: id,
        plan,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        proxy: downloadProxyConfig() ?? null,
      })
      emitTransferSuccess(taskId, 'Model', plan.total_bytes)
    } catch (error) {
      emitTransferError(taskId, 'Model', error)
      throw error
    } finally {
      unlisten()
    }
  })()
  running.set(id, work)
  void work
    .finally(() => {
      if (running.get(id) === work) running.delete(id)
    })
    .catch(() => {})
  return work
}
