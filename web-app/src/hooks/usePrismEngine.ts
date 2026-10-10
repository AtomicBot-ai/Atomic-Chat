import { useCallback, useEffect, useState } from 'react'
import { EngineManager, events } from '@janhq/core'

import { PRISM_PROVIDER } from '@/lib/model-setup'
import { switchBackendThroughCore } from '@/services/engines/update'

/** What the PrismML extension answers about its engine (`getEngineStatus`). */
export type PrismEngineStatus = {
  installed: boolean
  /** The `version/backend` the core would install here; `null` when none is offered. */
  recommended: string | null
}

type PrismExtension = {
  getEngineStatus(): Promise<PrismEngineStatus>
}

function prismExtension(): PrismExtension | null {
  const engine = EngineManager.instance().get(PRISM_PROVIDER) as
    | Partial<PrismExtension>
    | undefined
  return typeof engine?.getEngineStatus === 'function'
    ? (engine as PrismExtension)
    : null
}

function errorText(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error)
    return String((error as { message: unknown }).message)
  return String(error)
}

export type PrismEngine = {
  /** Whether the PrismML extension is loaded at all. */
  present: boolean
  /** `null` until the core has answered. */
  status: PrismEngineStatus | null
  checkError: string | null
  installing: boolean
  installError: string | null
  check: () => Promise<void>
  /** Install the build the core recommends; progress and Cancel are in the download panel. */
  install: () => Promise<void>
}

/**
 * Whether PrismML's engine is installed, and installing it, for the provider
 * page. The engine is not bundled with the app: until a pack is on disk the
 * page offers the build the core recommends. The extension re-reads the core's
 * catalog after an install and after `allow_candidate_builds` changes, and says
 * so with `settingsChanged`; the status is asked again then.
 */
export function usePrismEngine(enabled: boolean): PrismEngine {
  const [status, setStatus] = useState<PrismEngineStatus | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)

  const check = useCallback(async () => {
    const extension = prismExtension()
    if (!extension) return
    setCheckError(null)
    try {
      setStatus(await extension.getEngineStatus())
    } catch (error) {
      setCheckError(errorText(error))
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    void check()
    const onSettingsChanged = (event: { key?: string }) => {
      if (event?.key === 'version_backend') void check()
    }
    events.on('settingsChanged', onSettingsChanged)
    return () => events.off('settingsChanged', onSettingsChanged)
  }, [enabled, check])

  const install = useCallback(async () => {
    const extension = prismExtension()
    if (!extension || !status?.recommended) return
    setInstalling(true)
    setInstallError(null)
    try {
      // The core installs the build and makes it PrismML's active one.
      await switchBackendThroughCore(PRISM_PROVIDER, status.recommended)
    } catch (error) {
      setInstallError(errorText(error))
    } finally {
      setInstalling(false)
      void check()
    }
  }, [status, check])

  return {
    present: enabled && prismExtension() !== null,
    status,
    checkError,
    installing,
    installError,
    check,
    install,
  }
}
