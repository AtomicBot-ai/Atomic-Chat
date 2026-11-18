import { DownloadEvent, events } from '@janhq/core'
import {
  parseStrataDescriptor,
  strataSourceDigest,
} from '@atomic-chat/core/client'
import type { StrataModelDescriptor } from '@atomic-chat/core/contracts'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useDownloadStore, type DownloadStage } from '@/hooks/useDownloadStore'
import {
  downloadProxyConfig,
  emitTransferError,
  emitTransferProgress,
  emitTransferSuccess,
} from '@/services/diffusion/transfer'
import {
  beginStrataPreparation,
  changeStrataPreparation,
  readStrataPreparation,
} from './core'

interface StrataPlan {
  descriptor: StrataModelDescriptor
  request_id: string
  source_digest: string
}

export interface StrataJob {
  model_id: string
  state: 'acquiring' | 'publishing' | 'files-ready' | 'ready'
  plan: StrataPlan
  maintenance_id?: string | null
  running?: boolean
  removing?: boolean
}

export const strataTaskId = (id: string) =>
  `strata-model-${id.replaceAll('.', ':d')}`
export const isStrataTaskId = (id: string) => id.startsWith('strata-model-')

export function listStrataJobs() {
  return invoke<StrataJob[]>('atomic_strata_jobs')
}

interface Run {
  promise: Promise<void>
  cancelled: boolean
  operation?: string
  cancelRequest?: Promise<void>
}

const running = new Map<string, Run>()
export const isStrataRunning = (taskId: string) => running.has(taskId)

function preparing(taskId: string) {
  events.emit(DownloadEvent.onFileDownloadUpdate, {
    modelId: taskId,
    downloadType: 'Model',
    stage: { kind: 'strata-preparing', attempt: 0, maxAttempts: 0 },
  })
}

async function prepare(job: StrataJob, run: Run) {
  if (run.cancelled) throw new Error('Strata installation cancelled.')
  preparing(strataTaskId(job.model_id))
  let operation = await beginStrataPreparation({
    request_id: job.plan.request_id,
    model_id: job.model_id,
    source_digest: job.plan.source_digest,
    ...(job.maintenance_id ? { maintenance_id: job.maintenance_id } : {}),
  })
  run.operation = operation.operation_id
  if (
    !run.cancelled &&
    ['interrupted', 'failed', 'cancelled'].includes(operation.state)
  ) {
    operation = await changeStrataPreparation(operation.operation_id, 'resume')
  }
  let cancellationSent = false
  while (['queued', 'preparing', 'verifying'].includes(operation.state)) {
    if (run.cancelled && !cancellationSent) {
      await changeStrataPreparation(operation.operation_id, 'cancel')
      cancellationSent = true
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
    operation = await readStrataPreparation(operation.operation_id)
  }
  if (operation.state !== 'ready') {
    throw new Error(
      operation.error?.message ?? `Strata preparation ${operation.state}.`
    )
  }
  await invoke('atomic_strata_finish_install', { modelId: job.model_id })
}

function start(
  id: string,
  descriptor: StrataModelDescriptor,
  acquire: () => Promise<StrataJob>,
  filesReady = false
): Promise<void> {
  const task = strataTaskId(id)
  const existing = running.get(task)
  if (existing) return existing.promise
  const total = descriptor.requirements.download_bytes
  const run: Run = { cancelled: false, promise: Promise.resolve() }
  run.promise = (async () => {
    const store = useDownloadStore.getState()
    store.setDownloadOrigin(task, descriptor.name)
    store.addLocalDownloadingModel(task)
    let stop: (() => void) | undefined
    try {
      stop = await listen<{
        transferred: number
        total: number
        stage?: DownloadStage
      }>(`download-${task}`, ({ payload }) => {
        if (payload.stage) {
          events.emit(DownloadEvent.onFileDownloadUpdate, {
            modelId: task,
            downloadType: 'Model',
            stage: payload.stage,
          })
        } else {
          emitTransferProgress(
            task,
            'Model',
            payload.transferred,
            payload.total
          )
        }
      })
      if (run.cancelled) throw new Error('Strata installation cancelled.')
      if (!filesReady) emitTransferProgress(task, 'Model', 0, total)
      const job = await acquire()
      if (job.state !== 'ready') await prepare(job, run)
      emitTransferSuccess(task, 'Model', total)
    } catch (error) {
      store.markResumableDownload(task)
      emitTransferError(task, 'Model', error)
      throw error
    } finally {
      stop?.()
      store.removeLocalDownloadingModel(task)
    }
  })().finally(() => running.delete(task))
  running.set(task, run)
  return run.promise
}

function acquire(
  modelId: string,
  token?: string,
  plan?: StrataPlan,
  importFolder?: string
) {
  return invoke<StrataJob>('atomic_strata_acquire', {
    modelId,
    token: token || null,
    plan: plan ?? null,
    proxy: downloadProxyConfig() ?? null,
    importFolder: importFolder ?? null,
  })
}

export function installStrata(
  descriptor: StrataModelDescriptor,
  token?: string,
  importFolder?: string
) {
  return start(
    descriptor.variant_id,
    descriptor,
    async () => {
      const pinned = parseStrataDescriptor(descriptor)
      return acquire(
        pinned.variant_id,
        token,
        {
          descriptor: pinned,
          request_id: crypto.randomUUID(),
          source_digest: await strataSourceDigest(pinned),
        },
        importFolder
      )
    }
  )
}

export async function resumeStrata(taskId: string, token?: string) {
  const existing = running.get(taskId)
  if (existing && !existing.cancelled) return existing.promise
  await existing?.promise.catch(() => {})
  const job = (await listStrataJobs()).find(
    (row) => strataTaskId(row.model_id) === taskId
  )
  if (!job) throw new Error('The saved Strata plan is missing.')
  if (job.state === 'ready') return
  return start(
    job.model_id,
    job.plan.descriptor,
    () =>
      job.state === 'files-ready'
        ? Promise.resolve(job)
        : acquire(job.model_id, token),
    job.state === 'files-ready'
  )
}

export function cancelStrata(taskId: string) {
  const run = running.get(taskId)
  if (!run) return Promise.resolve()
  run.cancelled = true
  run.cancelRequest ??= cancelAcquisition(taskId, run)
  return run.cancelRequest
}

async function cancelAcquisition(taskId: string, run: Run) {
  // Preflight and journal writes precede registration of the downloader token.
  // Keep asking while acquisition is still in that window.
  while (running.get(taskId) === run && !run.operation) {
    try {
      await invoke('cancel_download_task', { taskId })
      return
    } catch (error) {
      if (!String(error).includes('No download task')) throw error
    }
    await Promise.race([
      run.promise.catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 100)),
    ])
  }
}
