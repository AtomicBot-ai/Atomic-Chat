/**
 * Tauri Diffusion Service — desktop implementation.
 *
 * Thin wrapper over `tauri-plugin-atomic-diffusion`. Every method is one
 * `invoke` of the snake_case command with the interface's parameter names as
 * camelCase argument keys; the plugin is written against the same contract
 * (`./types.ts`), so nothing is renamed on the way across the bridge.
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

export const PLUGIN = 'plugin:atomic-diffusion'

/** Event name → the discriminant we hand the UI. Tauri v2 rejects `.` in names. */
export const EVENT_MAP = {
  'atomic-diffusion://state': 'state',
  'atomic-diffusion://progress': 'progress',
  'atomic-diffusion://job': 'job',
  'atomic-diffusion://error': 'error',
} as const

export class TauriDiffusionService extends DefaultDiffusionService {
  override isSupported(): boolean {
    return true
  }

  override async configure(config: DiffusionConfig): Promise<DiffusionStatus> {
    return invoke<DiffusionStatus>(`${PLUGIN}|configure`, { config })
  }

  override async getStatus(): Promise<DiffusionStatus> {
    return invoke<DiffusionStatus>(`${PLUGIN}|get_status`)
  }

  override async finalizeBackendInstall(args: {
    dir: string
    tag: string
    backendId: string
    backend: DiffusionBackend
    engine: DiffusionEngineId
    sha256?: string
  }): Promise<DiffusionBackendInstallRecord> {
    return invoke<DiffusionBackendInstallRecord>(
      `${PLUGIN}|finalize_backend_install`,
      { args }
    )
  }

  override async listInstalledBackends(): Promise<
    DiffusionBackendInstallRecord[]
  > {
    return invoke<DiffusionBackendInstallRecord[]>(
      `${PLUGIN}|list_installed_backends`
    )
  }

  override async removeBackend(dir: string): Promise<void> {
    await invoke(`${PLUGIN}|remove_backend`, { dir })
  }

  override async listModelFiles(): Promise<DiffusionModelFile[]> {
    return invoke<DiffusionModelFile[]>(`${PLUGIN}|list_model_files`)
  }

  override async deleteModelFile(path: string): Promise<void> {
    await invoke(`${PLUGIN}|delete_model_file`, { path })
  }

  override async loadModel(
    request: LoadDiffusionModelRequest
  ): Promise<LoadedDiffusionModel> {
    return invoke<LoadedDiffusionModel>(`${PLUGIN}|load_model`, { request })
  }

  override async unloadModel(): Promise<void> {
    await invoke(`${PLUGIN}|unload_model`)
  }

  override async getCapabilities(): Promise<ImageCapabilities> {
    return invoke<ImageCapabilities>(`${PLUGIN}|get_capabilities`)
  }

  override async touchIdle(): Promise<void> {
    await invoke(`${PLUGIN}|touch_idle`)
  }

  override async generate(
    request: ImageGenerateRequest
  ): Promise<{ jobId: string }> {
    return invoke<{ jobId: string }>(`${PLUGIN}|generate`, { request })
  }

  override async getJob(jobId: string): Promise<ImageJob | null> {
    return invoke<ImageJob | null>(`${PLUGIN}|get_job`, { jobId })
  }

  override async cancelJob(
    jobId: string
  ): Promise<{ cancelled: boolean; serverStopped: boolean }> {
    return invoke<{ cancelled: boolean; serverStopped: boolean }>(
      `${PLUGIN}|cancel_job`,
      { jobId }
    )
  }

  override async listGallery(options: GalleryListOptions): Promise<GalleryPage> {
    return invoke<GalleryPage>(`${PLUGIN}|list_gallery`, { options })
  }

  override async getGalleryItem(id: string): Promise<GalleryImageItem | null> {
    return invoke<GalleryImageItem | null>(`${PLUGIN}|get_gallery_item`, {
      id,
    })
  }

  override async deleteGalleryItems(ids: string[]): Promise<void> {
    await invoke(`${PLUGIN}|delete_gallery_items`, { ids })
  }

  override async setGalleryFlags(
    id: string,
    flags: GalleryFlags
  ): Promise<GalleryImageItem> {
    return invoke<GalleryImageItem>(`${PLUGIN}|set_gallery_flags`, {
      id,
      flags,
    })
  }

  override async exportGalleryItem(
    id: string,
    targetPath: string
  ): Promise<void> {
    await invoke(`${PLUGIN}|export_gallery_item`, { id, targetPath })
  }

  override async setOutputDir(path: string): Promise<DiffusionStatus> {
    return invoke<DiffusionStatus>(`${PLUGIN}|set_output_dir`, { path })
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
