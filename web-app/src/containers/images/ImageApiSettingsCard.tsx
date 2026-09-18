import { IconArrowRight, IconCircleCheck, IconCircleX } from '@tabler/icons-react'
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

/**
 * Discoverability for the public image endpoint. The server and model controls
 * stay on their existing screens; this card only describes the shared route
 * and reflects whether its two prerequisites are currently available.
 */
export function ImageApiSettingsCard() {
  const { t } = useTranslation()
  const serverStatus = useAppState((state) => state.serverStatus)
  const model = useImageGenerationStore((state) => state.status?.model)
  const { serverHost, serverPort, apiPrefix, apiKey } = useLocalApiServer()

  const endpoint = useMemo(
    () =>
      `${getLocalApiServerUrl().replace(/\/+$/, '')}/images/generations`,
    // getLocalApiServerUrl reads the same persisted store values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [serverHost, serverPort, apiPrefix]
  )
  const serverReady = serverStatus === 'running'
  const modelReady = model?.state === 'loaded'
  const authRequired = apiKey.trim().length > 0
  const curl = [
    `curl -X POST '${endpoint}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    ...(authRequired
      ? [`  -H 'Authorization: Bearer YOUR_API_KEY' \\`]
      : []),
    `  -d '{"prompt":"A paper boat on a moonlit lake","size":"1024x1024","response_format":"b64_json"}'`,
  ].join('\n')

  return (
    <Card title={t('settings:media.apiTitle')}>
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
            <span className="flex items-center gap-1.5">
              {serverReady ? (
                <IconCircleCheck size={15} className="text-primary" />
              ) : (
                <IconCircleX size={15} className="text-muted-foreground" />
              )}
              {serverReady
                ? t('settings:media.apiServerRunning')
                : t('settings:media.apiServerStopped')}
            </span>
            <span className="flex items-center gap-1.5">
              {modelReady ? (
                <IconCircleCheck size={15} className="text-primary" />
              ) : (
                <IconCircleX size={15} className="text-muted-foreground" />
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

      <div className="mt-3 border-b border-border/40 pb-3">
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

      <div className="mt-3">
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
          className="mt-2 overflow-x-auto rounded-md bg-secondary/60 p-3 text-xs leading-relaxed text-foreground"
          data-testid="image-api-curl"
        >
          <code>{curl}</code>
        </pre>
      </div>
    </Card>
  )
}

export default ImageApiSettingsCard
