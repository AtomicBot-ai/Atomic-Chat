/**
 * Installing the MLX engine (`mlx-server`) through the core
 * (`/engine-builds/mlx`). The installer does not carry it: the core reads
 * conf's manifest, picks this Mac's build, downloads it with sha256 and size,
 * probes it and makes it active; the app only names the download task and
 * shows its progress. A new MLX model, the first load without an engine and
 * the provider page all install through `installMlxEngine`.
 */

import { create } from 'zustand'

import type { EngineVersions } from '@/services/engines/types'
import { useEngineVersionsStore } from '@/stores/engine-versions-store'

import { engineBuildCatalog, engineBuildProxy } from './core'
import { engineBuildTaskId, installEngineBuildWithProgress } from './install'
import type { EngineBuildInstallResult } from './types'

const ENGINE = 'mlx'

type MlxEngineInstallState = {
  /** An install runs, from the catalog read until the versions answer shows its build. */
  installing: boolean
  /** The running install's bytes, once the download reported any. */
  progress: { transferred: number; total: number } | null
}

/** The running install, for every surface that shows it. */
export const useMlxEngineInstallStore = create<MlxEngineInstallState>()(() => ({
  installing: false,
  progress: null,
}))

let running: Promise<EngineBuildInstallResult> | null = null

async function install(): Promise<EngineBuildInstallResult> {
  const proxy = engineBuildProxy()
  const catalog = await engineBuildCatalog(ENGINE, proxy ? { proxy } : {})
  // No manifest is a failed read, not a Mac without a build: the read's own
  // error goes to the caller, as the core's refusal would carry it.
  if (!catalog.manifest && catalog.manifest_error) {
    throw { code: 'UPSTREAM_ERROR', message: catalog.manifest_error }
  }
  if (!catalog.host_backend_id) {
    throw {
      code: 'UNSUPPORTED_BACKEND',
      message:
        catalog.host_reason ?? 'No MLX engine build is published for this Mac.',
    }
  }
  // Without a manifest the core refuses (`UPSTREAM_ERROR`); the id only has to be stable.
  const result = await installEngineBuildWithProgress(ENGINE, {
    taskId: engineBuildTaskId(ENGINE, catalog.manifest?.tag ?? 'unknown'),
    onProgress: (progress) => useMlxEngineInstallStore.setState({ progress }),
  })
  // The core's `engine:changed` refreshes the answer too; waiting for it here
  // keeps every surface from offering the install again in between.
  await useEngineVersionsStore.getState().refresh()
  return result
}

/**
 * Install this Mac's MLX build through the core. Calls made while one runs
 * share it, so the engine is never downloaded twice at once. Rejects with the
 * core's error as it came (`{code, message, details?}`); a Mac with no build
 * rejects with `UNSUPPORTED_BACKEND` and the core's reason, and an unreadable
 * manifest with `UPSTREAM_ERROR`, before any download starts. A cancel in the
 * download panel rejects with `CANCELLED`.
 */
export function installMlxEngine(): Promise<EngineBuildInstallResult> {
  if (running) return running
  useMlxEngineInstallStore.setState({ installing: true, progress: null })
  const promise = install().finally(() => {
    running = null
    useMlxEngineInstallStore.setState({ installing: false, progress: null })
  })
  running = promise
  return promise
}

/**
 * The install running now, for a load to wait for; `null` when none runs.
 * Never starts one.
 */
export function pendingMlxEngineInstall(): Promise<EngineBuildInstallResult> | null {
  return running
}

/**
 * Whether MLX has an active build, from MLX's entry in the core's versions
 * answer (`POST /engines/versions`): `null` when the answer says nothing about
 * it (no answer yet, a host without MLX, or a read that failed outright). A
 * manifest that could not be read still lists the builds on disk, so `false`
 * is only said when the core looked.
 */
export function mlxEngineActiveIn(
  versions: EngineVersions | undefined
): boolean | null {
  if (!versions) return null
  if (versions.active) return true
  // A failed read answers with `error` and no `source_error`; an unreachable
  // manifest names itself in `source_error` and still reports the disk.
  if (versions.error && versions.source_error === null) return null
  return false
}

/** Ask the core again, then {@link mlxEngineActiveIn} its MLX answer. */
export async function mlxEngineActive(): Promise<boolean | null> {
  await useEngineVersionsStore.getState().refresh()
  return mlxEngineActiveIn(useEngineVersionsStore.getState().engines[ENGINE])
}

/** The install ended because the user cancelled its download. */
export function isMlxEngineInstallCancelled(error: unknown): boolean {
  return (error as { code?: unknown } | null | undefined)?.code === 'CANCELLED'
}
