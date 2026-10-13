import { useCallback, useState } from 'react'
import { toast } from 'sonner'

import { useTranslation } from '@/i18n/react-i18next-compat'
import { useEngineVersionsStore } from '@/stores/engine-versions-store'

export type MlxBuild = { tag: string; origin: 'bundled' | 'downloaded' }

/**
 * The MLX provider's `version_backend` as mlx-extension writes it from the
 * core's catalog: `<tag>/<origin>`. Null for anything else (`detecting...`,
 * `none`, the `<tag> / macos-arm64` of an extension from before the core).
 */
export function describeMlxBuild(value: string): MlxBuild | null {
  const match = /^(\S+)\/(bundled|downloaded)$/.exec(value.trim())
  return match ? { tag: match[1], origin: match[2] as MlxBuild['origin'] } : null
}

/**
 * "Check engine updates" on the MLX provider page. Asks the core again with
 * every source re-read (`useEngineVersionsStore.refresh({force})`); the banner
 * offers what it finds, and this only tells the user what came of it.
 * Installing stays the banner's "Update", which the core applies.
 */
export function useMlxEngineUpdateCheck(): {
  checking: boolean
  check: () => Promise<void>
} {
  const { t } = useTranslation()
  const [checking, setChecking] = useState(false)

  const check = useCallback(async () => {
    setChecking(true)
    try {
      await useEngineVersionsStore.getState().refresh({ force: true })
      const { engines, error } = useEngineVersionsStore.getState()
      const mlx = engines.mlx
      const failure = mlx?.error ?? (mlx ? null : error)
      if (failure) {
        toast.error(t('settings:mlxEngine.checkFailed'), {
          description: failure.message,
        })
      } else if (mlx?.update.needed && mlx.update.target) {
        toast.info(
          t('settings:mlxEngine.updateAvailable', {
            version: mlx.update.target.version,
          })
        )
      } else {
        toast.success(t('settings:mlxEngine.upToDate'))
      }
    } finally {
      setChecking(false)
    }
  }, [t])

  return { checking, check }
}
