import { useEffect } from 'react'

import { clearLegacyEngineUpdateOffers } from '@/lib/engineUpdateOffer'
import { useEngineVersionsStore } from '@/stores/engine-versions-store'

/**
 * Follows the core's answer about every engine for the whole session
 * (`useEngineVersionsStore.bind`): the update banner, the installed builds
 * lists and the managed engine cards all read it. Desktop only: there is no
 * core on mobile or the web.
 */
export function useEngineVersionsSync(): void {
  useEffect(() => {
    if (!IS_TAURI || IS_IOS || IS_ANDROID) return
    clearLegacyEngineUpdateOffers()
    return useEngineVersionsStore.getState().bind()
  }, [])
}
