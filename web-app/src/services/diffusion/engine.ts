/**
 * Installing stable-diffusion.cpp through the core (`/engine-builds/sd-cpp`).
 *
 * The core reads conf's manifest, picks this host's build, downloads it with
 * sha256 and size, probes it, activates it and retires the old ones; the app
 * only names the download task and shows its progress. The task id keeps the
 * `diffusion-backend-<tag>-<backendId>` shape the download panel, the
 * notifications and the telemetry already know.
 */

import { getServiceHub } from '@/hooks/useServiceHub'
import { engineBuildProxy } from '@/services/engine-builds/core'
import { installEngineBuildWithProgress } from '@/services/engine-builds/install'
import type { EngineBuildInstallResult } from '@/services/engine-builds/types'

import { sanitizeTaskId } from './transfer'
import type { DiffusionError } from './types'

export const DIFFUSION_ENGINE_TASK_PREFIX = 'diffusion-backend-'

/** Download-panel row id; must satisfy Tauri's event-name alphabet. */
export function diffusionBackendTaskId(tag: string, backendId: string): string {
  return `${DIFFUSION_ENGINE_TASK_PREFIX}${sanitizeTaskId(tag)}-${sanitizeTaskId(backendId)}`
}

export function isDiffusionEngineTaskId(id: string): boolean {
  return id.startsWith(DIFFUSION_ENGINE_TASK_PREFIX)
}

/** The core's `/engine-builds` codes that have a diffusion counterpart (design D9). */
const CORE_TO_DIFFUSION: Record<string, DiffusionError['code']> = {
  BACKEND_INSUFFICIENT_DISK_SPACE: 'DISK_FULL',
  // The manifest could not be read: nothing was downloaded, and installing
  // again is what the card can offer.
  UPSTREAM_ERROR: 'ENGINE_INSTALL_FAILED',
  // Another window or client is installing the engine right now.
  ENGINE_INSTALL_IN_PROGRESS: 'ENGINE_INSTALL_FAILED',
}

/**
 * A rejection from the engine install as the `{code, message, details}` the
 * card and the banner route on. Codes the two contracts share
 * (`ENGINE_INSTALL_FAILED`, `UNSUPPORTED_BACKEND`, `CANCELLED`,
 * `BACKEND_IN_USE`) pass through; the rest of the core's codes are left for
 * `toDiffusionError` to read as `INTERNAL`.
 */
export function engineInstallError(error: unknown): unknown {
  const code = (error as { code?: unknown } | null | undefined)?.code
  if (typeof code !== 'string' || !(code in CORE_TO_DIFFUSION)) return error
  return { ...(error as object), code: CORE_TO_DIFFUSION[code] }
}

export type InstallDiffusionEngineOptions = {
  /** Reinstall the same build. The core never installs one older than the active build. */
  force?: boolean
  onProgress?: (progress: { transferred: number; total: number }) => void
}

/**
 * Install this host's sd.cpp build through the core. Rejects with the core's
 * error, untranslated (`engineInstallError` translates); a host with no build
 * rejects with `UNSUPPORTED_BACKEND` and the core's reason before any
 * download starts.
 */
export async function installDiffusionEngine(
  options: InstallDiffusionEngineOptions = {}
): Promise<EngineBuildInstallResult> {
  const diffusion = getServiceHub().diffusion()
  const proxy = engineBuildProxy()
  const catalog = await diffusion.engineCatalog(proxy ? { proxy } : {})
  if (!catalog.host_backend_id) {
    throw {
      code: 'UNSUPPORTED_BACKEND',
      message:
        catalog.host_reason ??
        'No stable-diffusion.cpp build is published for this computer.',
    }
  }
  // Without a manifest the core refuses (`UPSTREAM_ERROR`); the id only has to be stable.
  const taskId = diffusionBackendTaskId(
    catalog.manifest?.tag ?? 'unknown',
    catalog.host_backend_id
  )
  return installEngineBuildWithProgress('sd-cpp', {
    taskId,
    force: options.force,
    onProgress: options.onProgress,
    install: (request) => diffusion.installEngine(request),
  })
}

/**
 * What the desktop's own sd.cpp installer kept in `localStorage`: the conf
 * manifest with its fetch time and the builds that failed their probe. The
 * core keeps both on disk now (`<data>/diffusion/`); the keys only cost space.
 */
const INSTALLER_CACHE_KEYS = [
  'atomic_sdcpp_manifest_cache_v1',
  'atomic_sdcpp_manifest_cache_ts_v1',
  'atomic_sdcpp_failed_backends_v1',
]

export function forgetDesktopInstallerCaches(): void {
  try {
    for (const key of INSTALLER_CACHE_KEYS) window.localStorage.removeItem(key)
  } catch {
    // No storage (a private window, a blocked origin): nothing to forget.
  }
}
