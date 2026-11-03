import { IconDownload, IconLoader2 } from '@tabler/icons-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { extractModelErrorMessage } from '@/lib/modelErrorMessage'
import { cn, formatBytes } from '@/lib/utils'
import {
  installMlxEngine,
  isMlxEngineInstallCancelled,
  mlxEngineActiveIn,
  useMlxEngineInstallStore,
} from '@/services/engine-builds/mlx'
import { useEngineVersionsStore } from '@/stores/engine-versions-store'

/**
 * The MLX provider page while MLX has no engine: one line on what it is, its
 * download size when the core knows it, and the install with its progress and
 * its failure. The installer does not carry the engine; a new MLX model and a
 * first load install it too, and their install shows here as well. Renders
 * nothing until the core's versions answer says MLX has no active build, and
 * nothing once it has one (`installMlxEngine` reads the answer again).
 */
export function MlxEngineSetupCard() {
  const { t } = useTranslation()
  const versions = useEngineVersionsStore((state) => state.engines.mlx)
  const installing = useMlxEngineInstallStore((state) => state.installing)
  const progress = useMlxEngineInstallStore((state) => state.progress)
  const [error, setError] = useState<string | null>(null)

  if (mlxEngineActiveIn(versions) !== false) return null

  // The core sizes a build it offers; without an active one it may not.
  const size = versions?.latest?.download_bytes
  const percent =
    progress && progress.total > 0
      ? Math.round((progress.transferred / progress.total) * 100)
      : null

  const install = async () => {
    setError(null)
    try {
      await installMlxEngine()
    } catch (failure) {
      // A cancel in the download panel is the user's choice, not a failure.
      if (!isMlxEngineInstallCancelled(failure)) {
        setError(extractModelErrorMessage(failure))
      }
    }
  }

  return (
    <div
      className="flex flex-col gap-2 rounded-lg bg-card p-4 text-sm text-muted-foreground"
      data-testid="mlx-engine-setup"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p>{t('settings:mlxEngine.setup.description')}</p>
          {size ? (
            <p data-testid="mlx-engine-size">
              {t('settings:mlxEngine.setup.size', { size: formatBytes(size) })}
            </p>
          ) : null}
        </div>
        <Button
          size="sm"
          className="relative shrink-0"
          disabled={installing}
          aria-busy={installing}
          onClick={() => void install()}
          data-testid="mlx-engine-install"
        >
          {/* Transparent, not hidden: the label keeps the button's width and
              names it for screen readers while the loader stands in. */}
          <span
            className={cn(
              'inline-flex items-center gap-1.5',
              installing && 'opacity-0'
            )}
          >
            <IconDownload size={14} aria-hidden />
            {t('settings:mlxEngine.setup.install')}
          </span>
          {installing && (
            <span className="absolute inset-0 flex items-center justify-center">
              <IconLoader2 size={14} className="animate-spin" aria-hidden />
            </span>
          )}
        </Button>
      </div>

      {installing && (
        <div className="flex flex-col gap-1" data-testid="mlx-engine-progress">
          <span className="truncate text-xs tabular-nums">
            {percent === null
              ? t('settings:mlxEngine.installingEngine')
              : t('settings:mlxEngine.setup.progress', { percent })}
          </span>
          {percent !== null && <Progress value={percent} className="h-1" />}
        </div>
      )}

      {error && (
        <p className="break-words text-destructive" role="alert">
          {t('settings:mlxEngine.setup.failed', { error })}
        </p>
      )}
    </div>
  )
}
