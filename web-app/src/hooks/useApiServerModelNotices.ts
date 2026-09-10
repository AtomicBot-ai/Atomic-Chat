import { useEffect, useRef } from 'react'

import { useAppState } from '@/hooks/useAppState'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { makeNotice } from '@/utils/apiServerLogNormalize'

import { useApiServerLog } from './useApiServerLog'

/**
 * Adds "Model loaded" / "Model unloaded" rows to the request log.
 *
 * These come from the app's own model state rather than the proxy: a model
 * load is not an API request, but it is the context a reader needs to make
 * sense of the requests around it.
 */
export function useApiServerModelNotices() {
  const { t } = useTranslation()
  const activeModels = useAppState((state) => state.activeModels)
  // Seeded on first run so mounting the screen does not replay history the
  // user has already lived through.
  const seen = useRef<string[] | null>(null)

  useEffect(() => {
    const previous = seen.current
    seen.current = activeModels
    if (previous === null) return

    const loaded = activeModels.filter((id) => !previous.includes(id))
    const unloaded = previous.filter((id) => !activeModels.includes(id))
    const ops = [
      ...loaded.map((id) => ({ id, title: t('api:notice.modelLoaded') })),
      ...unloaded.map((id) => ({ id, title: t('api:notice.modelUnloaded') })),
    ]
    if (ops.length === 0) return

    useApiServerLog.getState().applyBatch(
      ops.map(({ id, title }, index) => ({
        t: 'start' as const,
        entry: makeNotice(`notice_${Date.now()}_${index}_${id}`, title, id),
      }))
    )
  }, [activeModels, t])
}
