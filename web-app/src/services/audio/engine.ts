/**
 * Installing audio.cpp through the core (`/engine-builds/audio-cpp`).
 *
 * The core reads conf's manifest, picks this host's build, downloads it with
 * sha256 and size, probes it and activates it; the app only names the download
 * task and shows its progress, as `services/diffusion/engine.ts` does for
 * sd.cpp.
 */

import { getServiceHub } from '@/hooks/useServiceHub'
import { engineBuildProxy } from '@/services/engine-builds/core'
import {
  engineBuildTaskId,
  installEngineBuildWithProgress,
} from '@/services/engine-builds/install'
import type { EngineBuildInstallResult } from '@/services/engine-builds/types'

import { AUDIO_ENGINE_ID, type AudioErrorCode } from './types'

/** The core's `/engine-builds` codes that have an audio counterpart. */
const CORE_TO_AUDIO: Record<string, AudioErrorCode> = {
  BACKEND_INSUFFICIENT_DISK_SPACE: 'DISK_FULL',
  // The manifest could not be read: nothing was downloaded, and installing
  // again is what the card can offer.
  UPSTREAM_ERROR: 'ENGINE_INSTALL_FAILED',
  // Another window or client is installing the engine right now.
  ENGINE_INSTALL_IN_PROGRESS: 'ENGINE_INSTALL_FAILED',
}

/** A rejection from the engine install, with the core's code read as an audio one. */
export function audioEngineInstallError(error: unknown): unknown {
  const code = (error as { code?: unknown } | null | undefined)?.code
  if (typeof code !== 'string' || !(code in CORE_TO_AUDIO)) return error
  return { ...(error as object), code: CORE_TO_AUDIO[code] }
}

export type InstallAudioEngineOptions = {
  /** Reinstall the same build. The core never installs one older than the active build. */
  force?: boolean
  onProgress?: (progress: { transferred: number; total: number }) => void
}

/**
 * Install this host's audio.cpp build. Rejects with the core's error,
 * untranslated (`audioEngineInstallError` translates); a host with no build
 * rejects with `UNSUPPORTED_BACKEND` and the core's reason before any download.
 */
export async function installAudioEngine(
  options: InstallAudioEngineOptions = {}
): Promise<EngineBuildInstallResult> {
  const audio = getServiceHub().audio()
  const proxy = engineBuildProxy()
  const catalog = await audio.engineCatalog(proxy ? { proxy } : {})
  if (!catalog.manifest && catalog.manifest_error) {
    throw { code: 'UPSTREAM_ERROR', message: catalog.manifest_error }
  }
  if (!catalog.host_backend_id) {
    throw {
      code: 'UNSUPPORTED_BACKEND',
      message:
        catalog.host_reason ??
        'No audio.cpp build is published for this computer.',
    }
  }
  return installEngineBuildWithProgress(AUDIO_ENGINE_ID, {
    taskId: engineBuildTaskId(
      AUDIO_ENGINE_ID,
      catalog.manifest?.tag ?? 'unknown'
    ),
    force: options.force,
    onProgress: options.onProgress,
    install: (request) => audio.installEngine(request),
  })
}
