import { ExtensionManager } from '@/lib/extension'
import { APIs } from '@/lib/service'
import { EventEmitter } from '@/services/events/EventEmitter'
import { EngineManager, ModelManager } from '@janhq/core'
import { PropsWithChildren, useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { BootLogLevel, bootLog, bootStep } from '@/lib/boot'
import { useTranslation } from '@/i18n/react-i18next-compat'

/**
 * Module-level guard so extension setup runs exactly once for the lifetime
 * of this module, regardless of how many times the effect below fires.
 *
 * This matters because `ExtensionProvider` sits at the app root and is
 * never expected to genuinely unmount during a session, but in dev mode
 * React 18 StrictMode intentionally double-invokes effects (mount ->
 * cleanup -> mount) to surface missing cleanup logic. Without this guard,
 * every extra invocation would recreate `window.core.extensionManager`
 * from scratch, orphaning the previous `ExtensionManager` (and every live
 * Tauri event listener its extensions registered, e.g. the llama.cpp
 * session-died listener) with no reference left to unlisten them. Those
 * orphaned listeners never got cleaned up and piled up across dev
 * reloads, eventually causing dozens of concurrent duplicate handlers to
 * fire on a single backend event and freezing the app.
 */
let extensionsSetupPromise: Promise<void> | null = null

/** The "some extensions didn't start" notice is shown once per process. */
let failureNoticeShown = false

export function ExtensionProvider({ children }: PropsWithChildren) {
  const { t } = useTranslation()
  const [finishedSetup, setFinishedSetup] = useState(false)
  const setupExtensions = useCallback(() => {
    if (!extensionsSetupPromise) {
      extensionsSetupPromise = (async () => {
        // Setup core window object for both platforms
        window.core = {
          api: APIs,
        }

        window.core.events = new EventEmitter()
        window.core.extensionManager = new ExtensionManager()
        window.core.engineManager = new EngineManager()
        window.core.modelManager = new ModelManager()

        // Register extensions - same pattern for both platforms
        bootStep('extensions', 'Loading extensions…')
        await ExtensionManager.getInstance()
          .registerActive()
          .then(() => ExtensionManager.getInstance().load())
      })().catch((error: unknown) => {
        // `registerActive` and `load` do not reject, but anything else in
        // here might. The app is drawn either way: before, a rejection here
        // meant `finishedSetup` never turned true and the window stayed blank.
        console.error('Extension setup failed:', error)
        bootLog(
          `extension setup failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          BootLogLevel.error
        )
      })
    }
    return extensionsSetupPromise.then(() => setFinishedSetup(true))
  }, [])

  useEffect(() => {
    setupExtensions()

    // Intentionally no unload-on-cleanup here: this provider is a
    // singleton at the app root, not a per-mount resource. Tearing
    // extensions down on React 18 StrictMode's synthetic dev-mode
    // cleanup (which fires immediately before the real mount) would
    // unload extensions that `setupExtensions` above just decided not
    // to reinitialize, leaving the app running with no active
    // extensions. A real process exit doesn't need this cleanup either.
  }, [setupExtensions])

  // Say so, once, when an extension failed or was still loading when startup
  // carried on without it - the app is up, but part of it may be missing.
  useEffect(() => {
    if (!finishedSetup || failureNoticeShown) return
    const failures = ExtensionManager.getInstance()?.getLoadFailures?.() ?? []
    if (failures.length === 0) return
    failureNoticeShown = true
    const names = failures
      .map((failure) =>
        failure.name.replace(/^@janhq\//, '').replace(/-extension$/, '')
      )
      .join(', ')
    toast.warning(t('common:startup.extensionsFailedTitle'), {
      id: 'extensions-failed-to-start',
      duration: Infinity,
      description: t('common:startup.extensionsFailedDescription', { names }),
      action: {
        label: t('common:startup.restart'),
        onClick: () => {
          void window.core?.api?.relaunch?.()
        },
      },
    })
  }, [finishedSetup, t])

  return <>{finishedSetup && children}</>
}
