/**
 * Tauri Audio Service — desktop implementation.
 *
 * A thin wrapper over the core's `/atomic/v1/audio/*` routes, reached through
 * the Rust relay (`atomic_core_call`): every method is one call with the
 * contract's camelCase JSON as its body. Paths travel in bodies, never in the
 * URL. Two routes wrap their answer so a `null` never stands alone (`{files}`,
 * `{job}`); they are unwrapped here. Events arrive as the relayed
 * `atomic-core://audio:*` events. The engine itself is installed through the
 * core's `/engine-builds/audio-cpp/*`, snake_case like every engine build.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import { createSafeUnlisten } from '@/lib/tauriEvent'
import {
  checkEngineBuildUpdates,
  engineBuildCatalog,
  installEngineBuild,
  removeEngineBuild,
} from '@/services/engine-builds/core'
import type {
  EngineBuildCatalog,
  EngineBuildCatalogRequest,
  EngineBuildInstallRequest,
  EngineBuildInstallResult,
  EngineBuildRemoveResult,
  EngineBuildUpdateCheck,
  EngineBuildUpdateCheckRequest,
} from '@/services/engine-builds/types'

import { DefaultAudioService } from './default'
import {
  AUDIO_ENGINE_ID,
  type AudioCancelResult,
  type AudioCapabilities,
  type AudioConfig,
  type AudioEvent,
  type AudioGalleryListOptions,
  type AudioGalleryPage,
  type AudioGenerateRequest,
  type AudioJob,
  type AudioJobSubmission,
  type AudioMode,
  type AudioModelFile,
  type AudioStatus,
  type LoadAudioModelRequest,
  type LoadedAudioModel,
} from './types'

/** The core's control-route prefix for audio generation. */
export const AUDIO_PREFIX = '/audio'

/** Relayed core event → the discriminant we hand the UI. */
export const AUDIO_EVENT_MAP = {
  'atomic-core://audio:state': 'state',
  'atomic-core://audio:job': 'job',
  'atomic-core://audio:error': 'error',
} as const

/** The relay's snapshot: a core generation attached. */
export const AUDIO_RESET_EVENT = 'atomic-core://snapshot'

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

/**
 * One relayed control call. A failure rejects with the relay's plain
 * `{code, message, details?}`, passed through untouched: an audio code when
 * the core's audio service refused, the relay's and the HTTP layer's own
 * otherwise (`lib/audio/errors.ts` reads both).
 */
function coreCall<T>(
  method: Method,
  path: string,
  body: unknown = null
): Promise<T> {
  return invoke<T>('atomic_core_call', {
    method,
    path: `${AUDIO_PREFIX}${path}`,
    body,
  })
}

export class TauriAudioService extends DefaultAudioService {
  override isSupported(): boolean {
    return true
  }

  override async getStatus(): Promise<AudioStatus> {
    return coreCall<AudioStatus>('GET', '/status')
  }

  override async configure(config: AudioConfig): Promise<AudioStatus> {
    return coreCall<AudioStatus>('PUT', '/config', config)
  }

  override async setOutputDir(path: string): Promise<AudioStatus> {
    return coreCall<AudioStatus>('PUT', '/output-dir', { path })
  }

  override async listModelFiles(): Promise<AudioModelFile[]> {
    const { files } = await coreCall<{ files: AudioModelFile[] }>(
      'GET',
      '/model-files'
    )
    return files
  }

  override async deleteModelFile(relativePath: string): Promise<void> {
    await coreCall<unknown>('DELETE', '/model-files', { relativePath })
  }

  override async loadModel(
    request: LoadAudioModelRequest
  ): Promise<LoadedAudioModel> {
    return coreCall<LoadedAudioModel>('POST', '/model/load', request)
  }

  override async unloadModel(): Promise<void> {
    await coreCall<unknown>('POST', '/model/unload')
  }

  override async touchIdle(): Promise<void> {
    await coreCall<unknown>('POST', '/idle/touch')
  }

  override async getCapabilities(): Promise<AudioCapabilities> {
    return coreCall<AudioCapabilities>('GET', '/capabilities')
  }

  override async generate(
    mode: AudioMode,
    request: AudioGenerateRequest
  ): Promise<AudioJob> {
    const submission: AudioJobSubmission = { mode, request }
    return coreCall<AudioJob>('POST', '/jobs', submission)
  }

  override async getJob(jobId: string): Promise<AudioJob | null> {
    const { job } = await coreCall<{ job: AudioJob | null }>(
      'GET',
      `/jobs/${encodeURIComponent(jobId)}`
    )
    return job
  }

  override async cancelJob(jobId: string): Promise<AudioCancelResult> {
    return coreCall<AudioCancelResult>(
      'POST',
      `/jobs/${encodeURIComponent(jobId)}/cancel`
    )
  }

  override async listGallery({
    offset,
    limit,
  }: AudioGalleryListOptions): Promise<AudioGalleryPage> {
    return coreCall<AudioGalleryPage>(
      'GET',
      `/gallery?offset=${offset}&limit=${limit}`
    )
  }

  override async deleteGalleryItem(id: string): Promise<void> {
    await coreCall<unknown>('DELETE', `/gallery/${encodeURIComponent(id)}`)
  }

  override async engineCatalog(
    request: EngineBuildCatalogRequest = {}
  ): Promise<EngineBuildCatalog> {
    return engineBuildCatalog(AUDIO_ENGINE_ID, request)
  }

  override async checkEngineUpdate(
    request: EngineBuildUpdateCheckRequest = {}
  ): Promise<EngineBuildUpdateCheck> {
    return checkEngineBuildUpdates(AUDIO_ENGINE_ID, request)
  }

  override async installEngine(
    request: EngineBuildInstallRequest
  ): Promise<EngineBuildInstallResult> {
    return installEngineBuild(AUDIO_ENGINE_ID, request)
  }

  override async removeEngineBuild(
    tag: string,
    backendId: string
  ): Promise<EngineBuildRemoveResult> {
    return removeEngineBuild(AUDIO_ENGINE_ID, tag, backendId)
  }

  override subscribe(handler: (event: AudioEvent) => void): () => void {
    const pending: Promise<UnlistenFn>[] = []

    for (const [name, type] of Object.entries(AUDIO_EVENT_MAP)) {
      pending.push(
        listen<Record<string, unknown>>(name, (event) => {
          handler({ ...event.payload, type } as AudioEvent)
        })
      )
    }
    pending.push(
      listen<unknown>(AUDIO_RESET_EVENT, () => handler({ type: 'reset' }))
    )

    let detached = false
    return () => {
      // A listener whose registration is still in flight must still be torn
      // down, so wait for each promise rather than dropping it. The flag keeps
      // a second call from unlistening the same handler twice.
      if (detached) return
      detached = true
      for (const promise of pending.splice(0)) {
        promise
          .then((unlisten) => createSafeUnlisten(unlisten)())
          .catch(() => {})
      }
    }
  }
}
