import { memo, type ReactNode } from 'react'
import { IconDownload, IconRefresh } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { describeAudioError } from '@/lib/audio/errors'
import { formatBytes } from '@/lib/utils'
import { useAudioGenerationStore } from '@/stores/audio-generation-store'

function Notice({
  title,
  children,
  action,
}: {
  title: string
  children?: ReactNode
  action?: ReactNode
}) {
  return (
    <div
      className="space-y-1.5 rounded-xl border bg-secondary/20 p-3"
      data-testid="audio-engine-notice"
    >
      <p className="text-xs font-medium">{title}</p>
      {children && (
        <div className="text-xs leading-snug text-muted-foreground">
          {children}
        </div>
      )}
      {action}
    </div>
  )
}

/**
 * What stands between the page and a running engine, stated once above the form
 * and never as an error: a core with no audio module (the app needs an update),
 * a computer with no build, or an engine still to install. Nothing is drawn
 * while the engine is ready, or while the core has not answered yet.
 */
export const AudioEngineNotice = memo(function AudioEngineNotice() {
  const { t } = useTranslation()
  const core = useAudioGenerationStore((state) => state.core)
  const installed = useAudioGenerationStore(
    (state) => state.status?.install.state === 'installed'
  )
  const resolved = useAudioGenerationStore((state) => state.hostBackendResolved)
  const hostBackendId = useAudioGenerationStore((state) => state.hostBackendId)
  const reason = useAudioGenerationStore((state) => state.hostBackendReason)
  const bytes = useAudioGenerationStore((state) => state.engineDownloadBytes)
  const install = useAudioGenerationStore((state) => state.engineInstall)
  const installEngine = useAudioGenerationStore((state) => state.installEngine)
  const refreshHostBackend = useAudioGenerationStore(
    (state) => state.refreshHostBackend
  )

  if (core === 'too-old') {
    return (
      <Notice title={t('audios:engine.coreTooOld.title')}>
        {t('audios:engine.coreTooOld.body')}
      </Notice>
    )
  }
  if (core === 'unreachable') {
    return (
      <Notice title={t('audios:engine.coreUnreachable.title')}>
        {t('audios:engine.coreUnreachable.body')}
      </Notice>
    )
  }
  if (core !== 'ready' || installed) return null

  if (install.inFlight) {
    const percent =
      install.total > 0
        ? Math.round((install.transferred / install.total) * 100)
        : 0
    return (
      <Notice title={t('audios:engine.installing')}>
        <Progress
          aria-label={t('audios:engine.installing')}
          value={percent}
          className="h-1 bg-muted"
        />
      </Notice>
    )
  }
  if (!resolved) return null

  if (!hostBackendId) {
    return (
      <Notice
        title={t('audios:engine.noBuild.title')}
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={() => void refreshHostBackend({ force: true })}
          >
            <IconRefresh size={14} />
            {t('audios:engine.retry')}
          </Button>
        }
      >
        {reason ?? t('audios:engine.noBuild.body')}
      </Notice>
    )
  }

  return (
    <Notice
      title={t('audios:engine.install.title')}
      action={
        <Button
          size="sm"
          variant="outline"
          onClick={() => void installEngine()}
          data-testid="audio-engine-install"
        >
          <IconDownload size={14} />
          {bytes
            ? t('audios:engine.install.actionSize', {
                size: formatBytes(bytes),
              })
            : t('audios:engine.install.action')}
        </Button>
      }
    >
      {install.error
        ? t(describeAudioError(install.error.code).bodyKey)
        : t('audios:engine.install.body')}
    </Notice>
  )
})
