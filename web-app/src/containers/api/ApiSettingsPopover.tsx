import { IconSettings2 } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { ApiKeyInput } from '@/containers/ApiKeyInput'
import { ApiPrefixInput } from '@/containers/ApiPrefixInput'
import { PortInput } from '@/containers/PortInput'
import { ProxyTimeoutInput } from '@/containers/ProxyTimeoutInput'
import { ServerHostSwitcher } from '@/containers/ServerHostSwitcher'
import { TrustedHostsInput } from '@/containers/TrustedHostsInput'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useTranslation } from '@/i18n/react-i18next-compat'

function Row({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{title}</p>
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

/**
 * Server configuration, lifted out of the old `LocalApiServerPanel` so the API
 * screen keeps the same fields and the same `settings:localApiServer.*` keys.
 */
export function ApiSettingsPopover({
  isServerRunning,
  showApiKeyError = false,
}: {
  isServerRunning: boolean
  showApiKeyError?: boolean
}) {
  const { t } = useTranslation()
  const { enableOnStartup, setEnableOnStartup } = useLocalApiServer()

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline">
          <IconSettings2 size={16} />
          {t('api:actions.settings')}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[480px] max-h-[70vh] overflow-y-auto"
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between border-b pb-2">
            <h2 className="text-sm font-semibold">
              {t('settings:localApiServer.serverConfiguration')}
            </h2>
          </div>

          <div className="space-y-3">
            <Row
              title={t('settings:localApiServer.serverHost')}
              description={t('settings:localApiServer.serverHostDesc')}
            >
              <ServerHostSwitcher isServerRunning={isServerRunning} />
            </Row>
            <Row
              title={t('settings:localApiServer.serverPort')}
              description={t('settings:localApiServer.serverPortDesc')}
            >
              <PortInput isServerRunning={isServerRunning} />
            </Row>
            <Row
              title={t('settings:localApiServer.apiPrefix')}
              description={t('settings:localApiServer.apiPrefixDesc')}
            >
              <ApiPrefixInput isServerRunning={isServerRunning} />
            </Row>
            <div className="flex flex-col space-y-1">
              <p className="text-sm font-medium">
                {t('settings:localApiServer.apiKey')}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('settings:localApiServer.apiKeyDesc')}
              </p>
              <div className="pt-1">
                <ApiKeyInput
                  isServerRunning={isServerRunning}
                  showError={showApiKeyError}
                />
              </div>
            </div>
            <div className="flex flex-col space-y-1">
              <p className="text-sm font-medium">
                {t('settings:localApiServer.trustedHosts')}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('settings:localApiServer.trustedHostsDesc')}
              </p>
              <div className="pt-1">
                <TrustedHostsInput isServerRunning={isServerRunning} />
              </div>
            </div>
            <Row
              title={t('settings:localApiServer.proxyTimeout')}
              description={t('settings:localApiServer.proxyTimeoutDesc')}
            >
              <ProxyTimeoutInput isServerRunning={isServerRunning} />
            </Row>
          </div>

          <div className="mt-4 flex items-center justify-between border-t border-border pt-4">
            <h2 className="text-sm font-semibold">
              {t('settings:localApiServer.advancedSettings')}
            </h2>
          </div>
          <div className="space-y-3">
            <Row
              title={t('settings:localApiServer.autoStart')}
              description={t('settings:localApiServer.autoStartDesc')}
            >
              <Switch
                checked={enableOnStartup}
                onCheckedChange={setEnableOnStartup}
              />
            </Row>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
