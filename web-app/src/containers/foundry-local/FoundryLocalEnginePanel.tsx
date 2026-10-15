import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Card, CardItem } from '@/containers/Card'
import { InstalledEngineBuilds } from '@/containers/engines/InstalledEngineBuilds'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { formatBytes } from '@/lib/utils'
import {
  engineBuildTaskId,
  installEngineBuildWithProgress,
} from '@/services/engine-builds/install'
import {
  engineUpdateTaskId,
  updateEngineWithProgress,
} from '@/services/engines/update'
import { useEngineVersionsStore } from '@/stores/engine-versions-store'

const ENGINE = 'foundry-local'

const messageOf = (error: unknown): string => {
  const message = (error as { message?: unknown } | null | undefined)?.message
  return typeof message === 'string' ? message : String(error)
}

/**
 * The Foundry Local runtime on its provider page (spec `foundry-local-desktop`, "Страница провайдера
 * ставит движок и готовит ускорители"): the first install with progress, the installed builds with
 * removal, the update the core's versions answer offers, and what Microsoft's library sends.
 *
 * Everything is read from the core's versions answer (`useEngineVersionsStore`): the build this host
 * would install is its `latest`, the installed ones its `builds`, the offer its `update`. The core
 * downloads under a task id the download panel shows, and its `engine:changed` refreshes the answer.
 */
export function FoundryLocalEnginePanel() {
  const { t } = useTranslation()
  const versions = useEngineVersionsStore((state) => state.engines[ENGINE])
  const refresh = useEngineVersionsStore((state) => state.refresh)
  const [progress, setProgress] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    setProgress(null)
    try {
      await action()
    } catch (refusal) {
      // A cancel in the download panel is the person's choice, not a failure.
      if ((refusal as { code?: unknown } | null)?.code !== 'CANCELLED') setError(messageOf(refusal))
    } finally {
      setBusy(false)
      setProgress(null)
      await refresh()
    }
  }

  const onProgress = ({ transferred, total }: { transferred: number; total: number }) =>
    setProgress(total > 0 ? transferred / total : 0)

  const installed = !!versions?.active
  const latest = versions?.latest ?? null
  const offer = versions?.update.needed ? versions.update.target : null

  const install = () => {
    if (!latest) return
    void run(() =>
      installEngineBuildWithProgress(ENGINE, {
        taskId: engineBuildTaskId(ENGINE, latest.version),
        onProgress,
      })
    )
  }

  const applyUpdate = () => {
    if (!offer) return
    void run(() =>
      updateEngineWithProgress(ENGINE, {
        taskId: engineUpdateTaskId(ENGINE, offer.version),
        backend: `${offer.version}/${offer.variant}`,
        onProgress,
      })
    )
  }

  return (
    <Card
      header={
        <h1 className="text-foreground font-medium text-base mb-4">
          {t('providers:foundryLocal.engine.title')}
        </h1>
      }
    >
      {installed ? (
        <CardItem
          title={t('providers:foundryLocal.engine.installed', {
            version: versions?.active?.version,
          })}
          description={t('providers:foundryLocal.engine.installedDescription')}
          actions={
            offer && (
              <Button size="sm" disabled={busy} onClick={applyUpdate}>
                {t('providers:foundryLocal.engine.update', { version: offer.version })}
              </Button>
            )
          }
        />
      ) : (
        <CardItem
          title={t('providers:foundryLocal.engine.notInstalled')}
          description={
            latest ? (
              t('providers:foundryLocal.engine.installDescription', {
                version: latest.version,
                size: latest.download_bytes ? formatBytes(latest.download_bytes) : '—',
              })
            ) : (
              <span className="text-destructive">
                {versions?.source_error ??
                  versions?.error?.message ??
                  t('providers:foundryLocal.engine.noBuild')}
              </span>
            )
          }
          actions={
            latest && (
              <Button size="sm" disabled={busy} onClick={install}>
                {t('providers:foundryLocal.engine.install', { version: latest.version })}
              </Button>
            )
          }
        />
      )}

      {busy && progress !== null && (
        <div className="mt-3 space-y-1">
          <span className="text-xs">
            {t('providers:foundryLocal.engine.installing', {
              percent: Math.round(progress * 100),
            })}
          </span>
          <Progress value={progress * 100} className="h-1" />
        </div>
      )}
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}

      {installed && <InstalledEngineBuilds engine={ENGINE} />}

      <p className="mt-4 text-xs leading-normal">{t('providers:foundryLocal.telemetry')}</p>
    </Card>
  )
}
