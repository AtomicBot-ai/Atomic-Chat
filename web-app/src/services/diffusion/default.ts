/**
 * Default Diffusion Service — the no-op used on web and mobile.
 *
 * Image generation needs the native `tauri-plugin-atomic-diffusion` plugin,
 * which supervises an `sd-server` process and owns the gallery on disk;
 * neither exists off the desktop. `isSupported()` returns false so the UI never
 * renders the Images page, getters return inert values so a stray read does not
 * crash a render, and every mutator rejects loudly in case something calls it.
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

import type {
  DiffusionBackend,
  DiffusionBackendInstallRecord,
  DiffusionConfig,
  DiffusionEngineId,
  DiffusionEvent,
  DiffusionModelFile,
  DiffusionService,
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

export const DIFFUSION_UNSUPPORTED =
  'Image generation is not available on this platform.'

const INERT_STATUS: DiffusionStatus = {
  configured: false,
  install: { state: 'not-installed' },
  model: { state: 'unloaded', loaded: null },
  activeJob: null,
  outputDir: '',
  idleUnloadSecs: 0,
}

const INERT_CAPABILITIES: ImageCapabilities = {
  workflows: [],
  minDim: 0,
  maxDim: 0,
  dimMultiple: 1,
  supportsNegativePrompt: false,
  supportsGuidance: false,
  cancelGenerating: false,
  maxBatch: 0,
  defaults: { steps: 0, cfgScale: 0, width: 0, height: 0 },
  ranges: { steps: [0, 0], dims: [0, 0], dimMultiple: 1 },
}

const unsupported = <T>(): Promise<T> =>
  Promise.reject(new Error(DIFFUSION_UNSUPPORTED))

export class DefaultDiffusionService implements DiffusionService {
  isSupported(): boolean {
    return false
  }

  async configure(_config: DiffusionConfig): Promise<DiffusionStatus> {
    return unsupported()
  }

  async getStatus(): Promise<DiffusionStatus> {
    return { ...INERT_STATUS }
  }

  async finalizeBackendInstall(_args: {
    dir: string
    tag: string
    backendId: string
    backend: DiffusionBackend
    engine: DiffusionEngineId
    sha256?: string
  }): Promise<DiffusionBackendInstallRecord> {
    return unsupported()
  }

  async listInstalledBackends(): Promise<DiffusionBackendInstallRecord[]> {
    return []
  }

  async removeBackend(_dir: string): Promise<void> {
    return unsupported()
  }

  async listModelFiles(): Promise<DiffusionModelFile[]> {
    return []
  }

  async deleteModelFile(_path: string): Promise<void> {
    return unsupported()
  }

  async loadModel(
    _request: LoadDiffusionModelRequest
  ): Promise<LoadedDiffusionModel> {
    return unsupported()
  }

  async unloadModel(): Promise<void> {
    return unsupported()
  }

  async getCapabilities(): Promise<ImageCapabilities> {
    return { ...INERT_CAPABILITIES }
  }

  async touchIdle(): Promise<void> {
    return unsupported()
  }

  async generate(_request: ImageGenerateRequest): Promise<{ jobId: string }> {
    return unsupported()
  }

  async getJob(_jobId: string): Promise<ImageJob | null> {
    return null
  }

  async cancelJob(
    _jobId: string
  ): Promise<{ cancelled: boolean; serverStopped: boolean }> {
    return unsupported()
  }

  async listGallery(_options: GalleryListOptions): Promise<GalleryPage> {
    return { items: [], hasMore: false, total: 0 }
  }

  async getGalleryItem(_id: string): Promise<GalleryImageItem | null> {
    return null
  }

  async deleteGalleryItems(_ids: string[]): Promise<void> {
    return unsupported()
  }

  async setGalleryFlags(
    _id: string,
    _flags: GalleryFlags
  ): Promise<GalleryImageItem> {
    return unsupported()
  }

  async exportGalleryItem(_id: string, _targetPath: string): Promise<void> {
    return unsupported()
  }

  async setOutputDir(_path: string): Promise<DiffusionStatus> {
    return unsupported()
  }

  subscribe(_handler: (event: DiffusionEvent) => void): () => void {
    return () => {}
  }
}
