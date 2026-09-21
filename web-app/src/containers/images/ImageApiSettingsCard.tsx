import {
  IconArrowRight,
  IconCircleCheck,
  IconCircleX,
} from '@tabler/icons-react'
import { Link } from '@tanstack/react-router'
import { useMemo } from 'react'

import { Button } from '@/components/ui/button'
import { route } from '@/constants/routes'
import { Card, CardItem } from '@/containers/Card'
import { CopyButton } from '@/containers/CopyButton'
import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { getLocalApiServerUrl } from '@/utils/localApiServerControl'

type ImageApiSettingsCardProps = {
  variant?: 'default' | 'embedded'
}

/**
 * Discoverability for the public image endpoint. The server and model controls
 * stay on their existing screens; this card only describes the shared route
 * and reflects whether its two prerequisites are currently available.
 */
export function ImageApiSettingsCard({
  variant = 'default',
}: ImageApiSettingsCardProps) {
  const { t } = useTranslation()
  const serverStatus = useAppState((state) => state.serverStatus)
  const model = useImageGenerationStore((state) => state.status?.model)
  const { serverHost, serverPort, apiPrefix, apiKey } = useLocalApiServer()

  const endpoint = useMemo(
    () => `${getLocalApiServerUrl().replace(/\/+$/, '')}/images/generations`,
    // getLocalApiServerUrl reads the same persisted store values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [serverHost, serverPort, apiPrefix]
  )
  const serverReady = serverStatus === 'running'
  const modelReady = model?.state === 'loaded'
  const authRequired = apiKey.trim().length > 0
  const embedded = variant === 'embedded'
  const curl = [
    `curl -X POST '${endpoint}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    ...(authRequired ? [`  -H 'Authorization: Bearer YOUR_API_KEY' \\`] : []),
    `  -d '{"prompt":"A paper boat on a moonlit lake","size":"1024x1024","response_format":"b64_json"}'`,
  ].join('\n')

  if (embedded) {
    return (
      <Card
        title={t('settings:media.apiTitle')}
        className="w-full min-w-0 rounded-xl border border-border/60 bg-card/60 p-3 text-muted-foreground"
      >
        <div
          className="min-w-0"
          data-testid="image-api-settings-card"
          data-variant={variant}
        >
          <CardItem
            align="start"
            className="min-w-0 flex-col items-stretch gap-2 [&>div:first-child]:w-full [&>div:first-child]:min-w-0"
            title={t('settings:media.apiEndpoint')}
            description={
              <span
                className="block max-w-full break-all font-mono text-xs"
                data-testid="image-api-endpoint"
              >
                {endpoint}
              </span>
            }
          />
          <div
            className="grid min-w-0 grid-cols-2 gap-2 pt-3"
            data-testid="image-api-embedded-actions"
          >
            <CopyButton
              text={endpoint}
              ariaLabel={t('settings:media.apiCopyEndpoint')}
              label={t('common:copy')}
              className="w-full min-w-0 rounded-full"
            />
            <Button
              asChild
              variant="outline"
              size="sm"
              className="w-full min-w-0 rounded-full"
            >
              <Link to={route.settings.media}>
                <span className="truncate">{t('settings:media.apiMore')}</span>
                <IconArrowRight size={14} />
              </Link>
            </Button>
          </div>
        </div>
      </Card>
    )
  }

  return (
    <Card title={t('settings:media.apiTitle')}>
      <div data-testid="image-api-settings-card" data-variant={variant}>
        <CardItem
          align="start"
          title={t('settings:media.apiEndpoint')}
          description={
            <span
              className="block break-all font-mono text-xs"
              data-testid="image-api-endpoint"
            >
              {endpoint}
            </span>
          }
          actions={
            <CopyButton
              text={endpoint}
              ariaLabel={t('settings:media.apiCopyEndpoint')}
            />
          }
        />

        <CardItem
          align="start"
          title={t('settings:media.apiRequirements')}
          description={
            <span className="block space-y-1 text-sm">
              <span className="flex min-w-0 items-center gap-1.5">
                {serverReady ? (
                  <IconCircleCheck
                    size={15}
                    className="shrink-0 text-primary"
                  />
                ) : (
                  <IconCircleX
                    size={15}
                    className="shrink-0 text-muted-foreground"
                  />
                )}
                {serverReady
                  ? t('settings:media.apiServerRunning')
                  : t('settings:media.apiServerStopped')}
              </span>
              <span className="flex min-w-0 items-center gap-1.5">
                {modelReady ? (
                  <IconCircleCheck
                    size={15}
                    className="shrink-0 text-primary"
                  />
                ) : (
                  <IconCircleX
                    size={15}
                    className="shrink-0 text-muted-foreground"
                  />
                )}
                {modelReady
                  ? t('settings:media.apiModelLoaded')
                  : t('settings:media.apiModelMissing')}
              </span>
              <span className="block pt-1">
                {t('settings:media.apiRequirementsHint')}
              </span>
            </span>
          }
          actions={
            <Button asChild variant="outline" size="sm">
              <Link to={route.api.index}>
                {t('settings:media.apiOpenSettings')}
                <IconArrowRight size={14} />
              </Link>
            </Button>
          }
        />

        <CardItem
          align="start"
          title={t('settings:media.apiAuthentication')}
          description={
            authRequired
              ? t('settings:media.apiAuthRequired')
              : t('settings:media.apiAuthDisabled')
          }
        />

        <div className="mt-3 min-w-0 border-b border-border/40 pb-3">
          <h2 className="font-medium text-foreground">
            {t('settings:media.apiContract')}
          </h2>
          <p className="mt-1.5 text-sm leading-relaxed">
            {t('settings:media.apiRequestContract')}
          </p>
          <p className="mt-1 text-sm leading-relaxed">
            {t('settings:media.apiResponseContract')}
          </p>
          <p className="mt-1 text-sm leading-relaxed">
            {t('settings:media.apiErrorContract')}
          </p>
        </div>

        <div className="mt-3 min-w-0">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-medium text-foreground">
              {t('settings:media.apiCurlExample')}
            </h2>
            <CopyButton
              text={curl}
              ariaLabel={t('settings:media.apiCopyCurl')}
            />
          </div>
          <pre
            className="mt-2 max-w-full overflow-x-auto rounded-md bg-secondary/60 p-3 text-xs leading-relaxed text-foreground"
            data-testid="image-api-curl"
          >
            <code>{curl}</code>
          </pre>
        </div>
      </div>
    </Card>
  )
}

export default ImageApiSettingsCard
