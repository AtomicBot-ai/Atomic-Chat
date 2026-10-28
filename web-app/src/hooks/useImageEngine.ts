import { useCallback } from 'react'

import type { DiffusionEngineInstall } from '@/services/diffusion/types'
import {
  HOST_CHECK_ATTEMPTS,
  useImageGenerationStore,
  type EngineInstallProgress,
} from '@/stores/image-generation-store'

export type ImageEngineState = {
  /** The plugin's install record, or `not-installed`. */
  install: DiffusionEngineInstall
  installed: boolean
  /** Null when this host has no supported build (Intel Mac, unsupported Linux). */
  hostBackendId: string | null
  hostBackendReason: string | null
  /** The check itself failed (no manifest, or no answer from the core), so Retry may help. */
  hostBackendCheckFailed: 'manifest' | 'core' | null
  /** The check's attempt in progress, or the last one made, of `hostBackendAttempts`. */
  hostBackendAttempt: number
  hostBackendAttempts: number
  /** Compatibility is still being detected. */
  resolvingHostBackend: boolean
  /** Run the host check again, re-reading the manifest. */
  retryHostBackend: () => Promise<void>
  /** More than one engine can serve this host, so the override dropdown is worth showing. */
  engineChoices: Array<'sd-cpp' | 'diffusers'>
  progress: EngineInstallProgress
  installing: boolean
  /** The manifest publishes a newer tag for this host. */
  updateAvailable: string | null
  checkingUpdate: boolean
  updateCheckedAt: number | null
  startInstall: () => Promise<void>
  reinstall: () => Promise<void>
  checkForUpdate: (opts?: { force?: boolean }) => Promise<void>
  update: () => Promise<void>
}

/**
 * Everything the setup dialog and the Media settings page need to know about
 * the `sd-server` binary. Purely derived from the generation store.
 */
export function useImageEngine(): ImageEngineState {
  const status = useImageGenerationStore((state) => state.status)
  const hostBackendId = useImageGenerationStore((state) => state.hostBackendId)
  const hostBackendReason = useImageGenerationStore(
    (state) => state.hostBackendReason
  )
  const hostBackendCheckFailed = useImageGenerationStore(
    (state) => state.hostBackendCheckFailed
  )
  const hostBackendAttempt = useImageGenerationStore(
    (state) => state.hostBackendAttempt
  )
  const hostBackendResolved = useImageGenerationStore(
    (state) => state.hostBackendResolved
  )
  const refreshHostBackend = useImageGenerationStore(
    (state) => state.refreshHostBackend
  )
  const progress = useImageGenerationStore((state) => state.engineInstall)
  const installEngine = useImageGenerationStore((state) => state.installEngine)
  const engineUpdate = useImageGenerationStore((state) => state.engineUpdate)
  const checkEngineUpdate = useImageGenerationStore(
    (state) => state.checkEngineUpdate
  )
  const updateEngine = useImageGenerationStore((state) => state.updateEngine)

  const install: DiffusionEngineInstall = status?.install ?? {
    state: 'not-installed',
  }

  // Phase 1 ships only stable-diffusion.cpp; the diffusers sidecar (phase 1b)
  // is CUDA-only, so the choice exists exactly on hosts with a CUDA backend id.
  const engineChoices: ImageEngineState['engineChoices'] =
    hostBackendId && hostBackendId.includes('cuda')
      ? ['sd-cpp', 'diffusers']
      : ['sd-cpp']

  const startInstall = useCallback(() => installEngine(), [installEngine])
  const reinstall = useCallback(
    () => installEngine({ force: true }),
    [installEngine]
  )
  const retryHostBackend = useCallback(
    () => refreshHostBackend({ force: true }),
    [refreshHostBackend]
  )

  return {
    install,
    installed: install.state === 'installed',
    hostBackendId,
    hostBackendReason,
    hostBackendCheckFailed,
    hostBackendAttempt,
    hostBackendAttempts: HOST_CHECK_ATTEMPTS,
    resolvingHostBackend: !hostBackendResolved && hostBackendId === null,
    retryHostBackend,
    engineChoices,
    progress,
    installing: progress.inFlight,
    updateAvailable: engineUpdate.availableTag,
    checkingUpdate: engineUpdate.checking,
    updateCheckedAt: engineUpdate.checkedAt,
    startInstall,
    reinstall,
    checkForUpdate: checkEngineUpdate,
    update: updateEngine,
  }
}
