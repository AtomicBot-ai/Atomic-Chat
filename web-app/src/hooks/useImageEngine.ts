import { useCallback } from 'react'

import type { DiffusionEngineInstall } from '@/services/diffusion/types'
import {
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
  /** More than one engine can serve this host, so the override dropdown is worth showing. */
  engineChoices: Array<'sd-cpp' | 'diffusers'>
  progress: EngineInstallProgress
  installing: boolean
  startInstall: () => Promise<void>
  reinstall: () => Promise<void>
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
  const progress = useImageGenerationStore((state) => state.engineInstall)
  const installEngine = useImageGenerationStore((state) => state.installEngine)

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

  return {
    install,
    installed: install.state === 'installed',
    hostBackendId,
    hostBackendReason,
    engineChoices,
    progress,
    installing: progress.inFlight,
    startInstall,
    reinstall,
  }
}
