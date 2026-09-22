/**
 * Tauri Diffusion Service — desktop implementation.
 *
 * A thin wrapper over the core's `/atomic/v1/diffusion/*` routes, reached
 * through the Rust relay (`atomic_core_call`): every method is one call with
 * the interface's parameter names as the camelCase JSON body, because the
 * core is written against the same contract (`./types.ts`). Four routes wrap
 * their answer so a `null` never stands alone as a body (`{backends}`,
 * `{files}`, `{job}`, `{item}`); they are unwrapped here. Events arrive as the
 * relayed `atomic-core://diffusion:*` events.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { createSafeUnlisten } from '@/lib/tauriEvent'

import { DefaultDiffusionService } from './default'
import type {
  DiffusionBackend,
  DiffusionBackendInstallRecord,
  DiffusionConfig,
  DiffusionEngineId,
  DiffusionEvent,
  DiffusionModelFile,
  DiffusionStatus,
  GalleryFlags,
  GalleryImageItem,
  GalleryListOptions,
  GalleryPage,
  ImageCapabilities,
  ImageGenerateRequest,
  ImageJob,
  LoadDiffusionModelRequest,
  LoadedDiffusionModel,
} from './types'

/** The core's control-route prefix for image generation. */
export const DIFFUSION_PREFIX = '/diffusion'

/** Relayed core event → the discriminant we hand the UI. */
export const EVENT_MAP = {
  'atomic-core://diffusion:state': 'state',
  'atomic-core://diffusion:progress': 'progress',
  'atomic-core://diffusion:job': 'job',
  'atomic-core://diffusion:error': 'error',
} as const

/**
 * The relay's snapshot: a core generation attached. The configuration lives
 * in the core's memory, so a new generation has to be told it again.
 */
export const RESET_EVENT = 'atomic-core://snapshot'

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * One relayed control call. A failure rejects with a plain
 * `{code, message, details?}` object (the relay's `CoreError`, not an
 * `Error`), passed through untouched. Its code is a diffusion code when the
 * core's image service refused; the relay and the core's HTTP layer reject
 * with their own (`CORE_UNREACHABLE`, `CORE_VERSION_MISMATCH`,
 * `INVALID_ARGUMENT`, `HTTP_<status>`, `INTERNAL_ERROR`, ...), which
 * `toDiffusionError` routes as `INTERNAL`, keeping the message and moving the
 * code into the details.
 */
export function coreCall<T>(
  method: Method,
  path: string,
  body: unknown = null
): Promise<T> {
  return invoke<T>('atomic_core_call', {
    method,
    path: `${DIFFUSION_PREFIX}${path}`,
    body,
  })
}

export class TauriDiffusionService extends DefaultDiffusionService {
  override isSupported(): boolean {
    return true
  }

  override async configure(config: DiffusionConfig): Promise<DiffusionStatus> {
    return coreCall<DiffusionStatus>('PUT', '/config', config)
  }

  override async getStatus(): Promise<DiffusionStatus> {
    return coreCall<DiffusionStatus>('GET', '/status')
  }

  override async finalizeBackendInstall(args: {
    dir: string
    tag: string
    backendId: string
    backend: DiffusionBackend
    engine: DiffusionEngineId
    sha256?: string
  }): Promise<DiffusionBackendInstallRecord> {
    return coreCall<DiffusionBackendInstallRecord>(
      'POST',
      '/backends/finalize',
      args
    )
  }

  override async listInstalledBackends(): Promise<
    DiffusionBackendInstallRecord[]
  > {
    const { backends } = await coreCall<{
      backends: DiffusionBackendInstallRecord[]
    }>('GET', '/backends')
    return backends
  }

  override async removeBackend(dir: string): Promise<void> {
    await coreCall('POST', '/backends/remove', { dir })
  }

  override async listModelFiles(): Promise<DiffusionModelFile[]> {
    const { files } = await coreCall<{ files: DiffusionModelFile[] }>(
      'GET',
      '/model-files'
    )
    return files
  }

  override async deleteModelFile(path: string): Promise<void> {
    await coreCall('POST', '/model-files/delete', { path })
  }

  override async loadModel(
    request: LoadDiffusionModelRequest
  ): Promise<LoadedDiffusionModel> {
    return coreCall<LoadedDiffusionModel>('POST', '/model/load', request)
  }

  override async unloadModel(): Promise<void> {
    await coreCall('POST', '/model/unload')
  }

  override async getCapabilities(): Promise<ImageCapabilities> {
    return coreCall<ImageCapabilities>('GET', '/capabilities')
  }

  override async touchIdle(): Promise<void> {
    await coreCall('POST', '/idle/touch')
  }

  override async generate(
    request: ImageGenerateRequest
  ): Promise<{ jobId: string }> {
    return coreCall<{ jobId: string }>('POST', '/jobs', request)
  }

  override async getJob(jobId: string): Promise<ImageJob | null> {
    const { job } = await coreCall<{ job: ImageJob | null }>(
      'GET',
      `/jobs/${encodeURIComponent(jobId)}`
    )
    return job
  }

  override async cancelJob(
    jobId: string
  ): Promise<{ cancelled: boolean; serverStopped: boolean }> {
    return coreCall<{ cancelled: boolean; serverStopped: boolean }>(
      'POST',
      `/jobs/${encodeURIComponent(jobId)}/cancel`
    )
  }

  override async listGallery(options: GalleryListOptions): Promise<GalleryPage> {
    const query = new URLSearchParams({
      offset: String(options.offset),
      limit: String(options.limit),
    })
    if (options.includeArchived !== undefined) {
      query.set('includeArchived', String(options.includeArchived))
    }
    return coreCall<GalleryPage>('GET', `/gallery?${query.toString()}`)
  }

  override async getGalleryItem(id: string): Promise<GalleryImageItem | null> {
    const { item } = await coreCall<{ item: GalleryImageItem | null }>(
      'GET',
      `/gallery/${encodeURIComponent(id)}`
    )
    return item
  }

  override async deleteGalleryItems(ids: string[]): Promise<void> {
    await coreCall('POST', '/gallery/delete', { ids })
  }

  override async setGalleryFlags(
    id: string,
    flags: GalleryFlags
  ): Promise<GalleryImageItem> {
    return coreCall<GalleryImageItem>(
      'PATCH',
      `/gallery/${encodeURIComponent(id)}/flags`,
      flags
    )
  }

  override async exportGalleryItem(
    id: string,
    targetPath: string
  ): Promise<void> {
    await coreCall('POST', `/gallery/${encodeURIComponent(id)}/export`, {
      targetPath,
    })
  }

  override async setOutputDir(path: string): Promise<DiffusionStatus> {
    return coreCall<DiffusionStatus>('PUT', '/output-dir', { path })
  }

  override subscribe(handler: (event: DiffusionEvent) => void): () => void {
    const pending: Promise<UnlistenFn>[] = []

    for (const [name, type] of Object.entries(EVENT_MAP)) {
      pending.push(
        listen<Record<string, unknown>>(name, (event) => {
          handler({ ...event.payload, type } as DiffusionEvent)
        })
      )
    }
    pending.push(
      listen<{ generation?: unknown }>(RESET_EVENT, (event) => {
        const generation = event.payload?.generation
        handler({
          type: 'reset',
          generation: typeof generation === 'number' ? generation : null,
        })
      })
    )

    let detached = false
    return () => {
      // A listener whose registration is still in flight must still be torn
      // down, so wait for each promise rather than dropping it. The flag keeps
      // a second call (StrictMode, two consumers) from unlistening the same
      // handler twice, which is what raises Tauri's
      // `listeners[eventId].handlerId` TypeError.
      if (detached) return
      detached = true
      for (const promise of pending.splice(0)) {
        promise.then((unlisten) => createSafeUnlisten(unlisten)()).catch(() => {})
      }
    }
  }
}
