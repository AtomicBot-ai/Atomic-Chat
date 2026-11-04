/**
 * Default Audio Service — the no-op used on web and mobile.
 *
 * Audio generation runs in the core, which exists only on the desktop.
 * `isSupported()` is false so the store never calls out, getters return inert
 * values so a stray read does not crash a render, and every mutator rejects
 * loudly in case something calls it.
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

import type {
  EngineBuildCatalog,
  EngineBuildCatalogRequest,
  EngineBuildInstallRequest,
  EngineBuildInstallResult,
  EngineBuildRemoveResult,
  EngineBuildUpdateCheck,
  EngineBuildUpdateCheckRequest,
} from '@/services/engine-builds/types'

import type {
  AudioCancelResult,
  AudioCapabilities,
  AudioConfig,
  AudioEvent,
  AudioGalleryListOptions,
  AudioGalleryPage,
  AudioGenerateRequest,
  AudioJob,
  AudioMode,
  AudioModelFile,
  AudioService,
  AudioStatus,
  LoadAudioModelRequest,
  LoadedAudioModel,
} from './types'

export const AUDIO_UNSUPPORTED =
  'Audio generation is not available on this platform.'

const INERT_STATUS: AudioStatus = {
  install: { state: 'not-installed' },
  model: { state: 'unloaded', loaded: null },
  activeJob: null,
  outputDir: '',
  idleUnloadSecs: 0,
}

const unsupported = <T>(): Promise<T> =>
  Promise.reject(new Error(AUDIO_UNSUPPORTED))

export class DefaultAudioService implements AudioService {
  isSupported(): boolean {
    return false
  }

  async getStatus(): Promise<AudioStatus> {
    return { ...INERT_STATUS }
  }

  async configure(_config: AudioConfig): Promise<AudioStatus> {
    return unsupported()
  }

  async setOutputDir(_path: string): Promise<AudioStatus> {
    return unsupported()
  }

  async listModelFiles(): Promise<AudioModelFile[]> {
    return []
  }

  async deleteModelFile(_relativePath: string): Promise<void> {
    return unsupported()
  }

  async loadModel(_request: LoadAudioModelRequest): Promise<LoadedAudioModel> {
    return unsupported()
  }

  async unloadModel(): Promise<void> {
    return unsupported()
  }

  async touchIdle(): Promise<void> {
    return unsupported()
  }

  async getCapabilities(): Promise<AudioCapabilities> {
    return unsupported()
  }

  async generate(
    _mode: AudioMode,
    _request: AudioGenerateRequest
  ): Promise<AudioJob> {
    return unsupported()
  }

  async getJob(_jobId: string): Promise<AudioJob | null> {
    return null
  }

  async cancelJob(_jobId: string): Promise<AudioCancelResult> {
    return unsupported()
  }

  async listGallery(
    _options: AudioGalleryListOptions
  ): Promise<AudioGalleryPage> {
    return { items: [], hasMore: false, total: 0 }
  }

  async deleteGalleryItem(_id: string): Promise<void> {
    return unsupported()
  }

  async engineCatalog(
    _request?: EngineBuildCatalogRequest
  ): Promise<EngineBuildCatalog> {
    return unsupported()
  }

  async checkEngineUpdate(
    _request?: EngineBuildUpdateCheckRequest
  ): Promise<EngineBuildUpdateCheck> {
    return { update_needed: false, current: null, target: null }
  }

  async installEngine(
    _request: EngineBuildInstallRequest
  ): Promise<EngineBuildInstallResult> {
    return unsupported()
  }

  async removeEngineBuild(
    _tag: string,
    _backendId: string
  ): Promise<EngineBuildRemoveResult> {
    return unsupported()
  }

  subscribe(_handler: (event: AudioEvent) => void): () => void {
    return () => {}
  }
}
