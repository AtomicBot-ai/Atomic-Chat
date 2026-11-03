import { IconLoader2 } from '@tabler/icons-react'
import { useState, type ReactNode } from 'react'

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

const ENGINE = 'geniex'

const messageOf = (error: unknown): string => {
  const message = (error as { message?: unknown } | null | undefined)?.message
  return typeof message === 'string' ? message : String(error)
}

/**
 * The GenieX SDK on its provider page (spec `geniex-desktop`, "Страница провайдера ставит движок и
 * показывает устройства"): the first install with progress, the installed builds with removal and
 * the update the core's versions answer offers. Nothing is prepared afterwards: the NPU and GPU
 * libraries ship inside the SDK, and `GeniexDevices` lists what the library found.
 *
 * Everything is read from the core's versions answer (`useEngineVersionsStore`): the build this host
 * would install is its `latest`, the installed ones its `builds`, the offer its `update`. The core
 * downloads under a task id the download panel shows, and its `engine:changed` refreshes the answer.
 */
export function GeniexEnginePanel() {
  const { t } = useTranslation()
  const versions = useEngineVersionsStore((state) => state.engines[ENGINE])
  const refresh = useEngineVersionsStore((state) => state.refresh)
  const storeError = useEngineVersionsStore((state) => state.error)
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
          {t('providers:geniex.engine.title')}
        </h1>
      }
    >
      {!versions ? (
        // The core's versions answer is not in yet: nothing is known about the engine.
        <CardItem
          title={t('providers:geniex.engine.title')}
          description={storeError ? storeError.message : t('providers:geniex.engine.checking')}
          actions={
            storeError && (
              <Button size="sm" variant="outline" onClick={() => void refresh()}>
                {t('providers:geniex.engine.checkAgain')}
              </Button>
            )
          }
        />
      ) : installed ? (
        <CardItem
          title={t('providers:geniex.engine.installed', {
            version: versions?.active?.version,
          })}
          description={t('providers:geniex.engine.installedDescription')}
          actions={
            offer && (
              <BusyButton busy={busy} onClick={applyUpdate}>
                {t('providers:geniex.engine.update', { version: offer.version })}
              </BusyButton>
            )
          }
        />
      ) : (
        <CardItem
          title={t('providers:geniex.engine.notInstalled')}
          description={
            latest ? (
              t('providers:geniex.engine.installDescription', {
                version: latest.version,
                size: latest.download_bytes ? formatBytes(latest.download_bytes) : '—',
              })
            ) : (
              <span className="text-destructive">
                {versions?.source_error ??
                  versions?.error?.message ??
                  t('providers:geniex.engine.noBuild')}
              </span>
            )
          }
          actions={
            latest && (
              <BusyButton busy={busy} onClick={install}>
                {t('providers:geniex.engine.install', { version: latest.version })}
              </BusyButton>
            )
          }
        />
      )}

      {busy && progress !== null && (
        <div className="mt-3 space-y-1">
          <span className="text-xs">
            {t('providers:geniex.engine.installing', {
              percent: Math.round(progress * 100),
            })}
          </span>
          <Progress value={progress * 100} className="h-1" />
        </div>
      )}
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}

      {installed && <InstalledEngineBuilds engine={ENGINE} />}
    </Card>
  )
}

/**
 * The install/update button: from the click until the core answers it shows a loader in place of
 * its label. The core downloads the manifest and the archive's first bytes before any progress
 * arrives, which took seconds with nothing but a greyed-out button. The label stays in the box,
 * transparent, so the button keeps its size.
 */
function BusyButton({
  busy,
  onClick,
  children,
}: {
  busy: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Button size="sm" disabled={busy} aria-busy={busy} onClick={onClick} className="relative">
      {/* Transparent, not `invisible`: the label keeps naming the button for screen readers. */}
      <span className={busy ? 'opacity-0' : undefined}>{children}</span>
      {busy && (
        <span className="absolute inset-0 flex items-center justify-center" data-testid="geniex-engine-busy">
          <IconLoader2 size={16} className="animate-spin" aria-hidden />
        </span>
      )}
    </Button>
  )
}
