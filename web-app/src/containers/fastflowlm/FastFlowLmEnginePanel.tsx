import { IconLoader2 } from '@tabler/icons-react'
import { useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Card, CardItem } from '@/containers/Card'
import { InstalledEngineBuilds } from '@/containers/engines/InstalledEngineBuilds'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { formatBytes } from '@/lib/utils'
import {
  installFastFlowLmEngine,
  useFastFlowLmEngineInstallStore,
} from '@/services/engine-builds/fastflowlm'
import {
  engineUpdateTaskId,
  updateEngineWithProgress,
} from '@/services/engines/update'
import { useEngineVersionsStore } from '@/stores/engine-versions-store'

const ENGINE = 'fastflowlm'

const messageOf = (error: unknown): string => {
  const message = (error as { message?: unknown } | null | undefined)?.message
  return typeof message === 'string' ? message : String(error)
}

export function FastFlowLmEnginePanel() {
  const { t } = useTranslation()
  const versions = useEngineVersionsStore((state) => state.engines[ENGINE])
  const refresh = useEngineVersionsStore((state) => state.refresh)
  const storeError = useEngineVersionsStore((state) => state.error)
  const installing = useFastFlowLmEngineInstallStore(
    (state) => state.installing
  )
  const engineProgress = useFastFlowLmEngineInstallStore(
    (state) => state.progress
  )
  const [localProgress, setProgress] = useState<number | null>(null)
  const [localBusy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    setProgress(null)
    try {
      await action()
    } catch (refusal) {
      // A cancel in the download panel is the person's choice, not a failure.
      if ((refusal as { code?: unknown } | null)?.code !== 'CANCELLED')
        setError(messageOf(refusal))
    } finally {
      setBusy(false)
      setProgress(null)
      await refresh()
    }
  }

  const onProgress = ({
    transferred,
    total,
  }: {
    transferred: number
    total: number
  }) => setProgress(total > 0 ? transferred / total : 0)

  const busy = localBusy || installing
  const progress =
    engineProgress && engineProgress.total > 0
      ? engineProgress.transferred / engineProgress.total
      : localProgress
  const installed = !!versions?.active
  const latest = versions?.latest ?? null
  const offer = versions?.update.needed ? versions.update.target : null

  const install = () => {
    setError(null)
    void installFastFlowLmEngine().catch((refusal) => {
      if ((refusal as { code?: unknown } | null)?.code !== 'CANCELLED')
        setError(messageOf(refusal))
    })
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
          {t('providers:fastflowlm.engine.title')}
        </h1>
      }
    >
      {!versions ? (
        // The core's versions answer is not in yet: nothing is known about the engine.
        <CardItem
          title={t('providers:fastflowlm.engine.title')}
          description={
            storeError
              ? storeError.message
              : t('providers:fastflowlm.engine.checking')
          }
          actions={
            storeError && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void refresh()}
              >
                {t('providers:fastflowlm.engine.checkAgain')}
              </Button>
            )
          }
        />
      ) : installed ? (
        <CardItem
          title={t('providers:fastflowlm.engine.installed', {
            version: versions?.active?.version,
          })}
          description={t('providers:fastflowlm.engine.installedDescription')}
          actions={
            offer && (
              <BusyButton busy={busy} onClick={applyUpdate}>
                {t('providers:fastflowlm.engine.update', {
                  version: offer.version,
                })}
              </BusyButton>
            )
          }
        />
      ) : (
        <CardItem
          title={t('providers:fastflowlm.engine.notInstalled')}
          description={
            latest ? (
              t('providers:fastflowlm.engine.installDescription', {
                version: latest.version,
                size: latest.download_bytes
                  ? formatBytes(latest.download_bytes)
                  : '—',
              })
            ) : (
              <span className="text-destructive">
                {versions?.source_error ??
                  versions?.error?.message ??
                  t('providers:fastflowlm.engine.noBuild')}
              </span>
            )
          }
          actions={
            latest && (
              <BusyButton busy={busy} onClick={install}>
                {t('providers:fastflowlm.engine.install', {
                  version: latest.version,
                })}
              </BusyButton>
            )
          }
        />
      )}

      {busy && progress !== null && (
        <div className="mt-3 space-y-1">
          <span className="text-xs">
            {t('providers:fastflowlm.engine.installing', {
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
    <Button
      size="sm"
      disabled={busy}
      aria-busy={busy}
      onClick={onClick}
      className="relative"
    >
      {}
      <span className={busy ? 'opacity-0' : undefined}>{children}</span>
      {busy && (
        <span
          className="absolute inset-0 flex items-center justify-center"
          data-testid="fastflowlm-engine-busy"
        >
          <IconLoader2 size={16} className="animate-spin" aria-hidden />
        </span>
      )}
    </Button>
  )
}
