import { useCallback, useState } from 'react'
import { toast } from 'sonner'

import { useTranslation } from '@/i18n/react-i18next-compat'
import { ExtensionManager } from '@/lib/extension'

const MLX_EXTENSION = '@janhq/mlx-extension'

interface MlxEngineUpdateCapableExtension {
  checkForEngineUpdate?(options?: { force?: boolean }): Promise<{
    updateAvailable: boolean
    targetVersion: string | null
  }>
}

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
 * "Check engine updates" on the MLX provider page. mlx-extension asks the
 * core with the manifest re-read and publishes the banner's offer itself;
 * this only tells the user what came of it. Installing stays the banner's
 * "Update" (design D10).
 */
export function useMlxEngineUpdateCheck(): {
  checking: boolean
  check: () => Promise<void>
} {
  const { t } = useTranslation()
  const [checking, setChecking] = useState(false)

  const check = useCallback(async () => {
    const extension = ExtensionManager.getInstance().getByName(MLX_EXTENSION) as
      | MlxEngineUpdateCapableExtension
      | undefined
    if (!extension?.checkForEngineUpdate) return
    setChecking(true)
    try {
      const { updateAvailable, targetVersion } =
        await extension.checkForEngineUpdate({ force: true })
      if (updateAvailable && targetVersion) {
        toast.info(t('settings:mlxEngine.updateAvailable', { version: targetVersion }))
      } else {
        toast.success(t('settings:mlxEngine.upToDate'))
      }
    } catch (error) {
      const message = (error as { message?: unknown } | null)?.message
      toast.error(t('settings:mlxEngine.checkFailed'), {
        description: typeof message === 'string' ? message : String(error),
      })
    } finally {
      setChecking(false)
    }
  }, [t])

  return { checking, check }
}
