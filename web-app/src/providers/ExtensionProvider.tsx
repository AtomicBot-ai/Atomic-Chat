import { ExtensionManager } from '@/lib/extension'
import { APIs } from '@/lib/service'
import { EventEmitter } from '@/services/events/EventEmitter'
import { EngineManager, ModelManager } from '@janhq/core'
import { PropsWithChildren, useCallback, useEffect, useState } from 'react'

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

export function ExtensionProvider({ children }: PropsWithChildren) {
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
        await ExtensionManager.getInstance()
          .registerActive()
          .then(() => ExtensionManager.getInstance().load())
      })()
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

  return <>{finishedSetup && children}</>
}
