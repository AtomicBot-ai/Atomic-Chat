import { IconDownload, IconLoader2 } from '@tabler/icons-react'
import { useNavigate } from '@tanstack/react-router'

import { Button } from '@/components/ui/button'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { PrismEngine } from '@/hooks/usePrismEngine'

/**
 * The PrismML provider page before its engine is installed: one line on what
 * it is for, and the way to the models that need it. The install itself is the
 * button in the Version & Backend row ({@link PrismEngineInstallButton}).
 * Renders nothing once a build is on disk.
 */
export function PrismEngineSetupCard({
  engine,
  versionBackend,
}: {
  engine: PrismEngine
  /** The provider's `version_backend`; `none` until a build is configured. */
  versionBackend: string
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { present, status, checkError } = engine

  if (!present || status?.installed) return null
  // A configured build is most likely on disk: say nothing until the core confirms.
  if (!status && !checkError && versionBackend && versionBackend !== 'none')
    return null

  return (
    <div
      className="flex flex-col gap-2 rounded-lg bg-card p-4 text-sm text-muted-foreground"
      data-testid="prism-engine-setup"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0">{t('providers:prismEngine.description')}</p>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() =>
            navigate({
              to: route.hub.index,
              search: { engine: 'atomic-prism' },
            })
          }
        >
          {t('providers:prismEngine.findModels')}
        </Button>
      </div>

      {status && !status.recommended && (
        <p data-testid="prism-engine-no-build">
          {t('providers:prismEngine.noBuild')}
        </p>
      )}

      {checkError && (
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 break-words text-destructive">
            {t('providers:prismEngine.checkFailed', { error: checkError })}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void engine.check()}
          >
            {t('providers:prismEngine.checkAgain')}
          </Button>
        </div>
      )}

      {engine.installError && (
        <p className="break-words text-destructive" role="alert">
          {t('providers:prismEngine.installFailed', {
            error: engine.installError,
          })}
        </p>
      )}
    </div>
  )
}

/**
 * The Version & Backend row while PrismML's engine is not installed: one
 * button that installs the build the core recommends for this machine.
 * Disabled while the core is asked, and when it offers no build.
 */
export function PrismEngineInstallButton({ engine }: { engine: PrismEngine }) {
  const { t } = useTranslation()
  const { status, installing } = engine
  const waiting = installing || (!status && !engine.checkError)

  return (
    <Button
      className="min-w-40 justify-center"
      disabled={waiting || !status?.recommended}
      onClick={() => void engine.install()}
      title={status?.recommended ?? undefined}
      data-testid="prism-engine-install"
    >
      {waiting ? (
        <IconLoader2 size={16} className="animate-spin" />
      ) : (
        <IconDownload size={16} />
      )}
      {installing
        ? t('providers:prismEngine.installing')
        : t('providers:prismEngine.install')}
    </Button>
  )
}
