import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import HeaderPage from '@/containers/HeaderPage'
import SettingsMenu from '@/containers/SettingsMenu'
import { Card, CardItem } from '@/containers/Card'
import { Switch } from '@/components/ui/switch'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { EyeOff, Eye } from 'lucide-react'
import { useCallback, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { IconLoader } from '@tabler/icons-react'
import { useProxyConfig } from '@/hooks/useProxyConfig'

/** Mirrors `ProxyTestResult` in `src-tauri/src/core/downloads/commands.rs`. */
type ProxyTestResult = {
  ok: boolean
  kind:
    | 'ok'
    | 'bypassed'
    | 'invalid_config'
    | 'unreachable'
    | 'auth_failed'
    | 'http_error'
  detail: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.https_proxy as any)({
  component: HTTPSProxyContent,
})

function HTTPSProxyContent() {
  const { t } = useTranslation()
  const [showPassword, setShowPassword] = useState(false)
  const {
    proxyUrl,
    proxyEnabled,
    proxyUsername,
    proxyPassword,
    proxyIgnoreSSL,
    noProxy: noProxyList,
    setProxyEnabled,
    setProxyUsername,
    setProxyPassword,
    setProxyIgnoreSSL,
    setNoProxy,
    setProxyUrl,
  } = useProxyConfig()

  const [testing, setTesting] = useState(false)

  const toggleProxy = useCallback(
    (checked: boolean) => {
      setProxyEnabled(checked)
    },
    [setProxyEnabled]
  )

  /**
   * ATO — #290/#289: nothing in the app had ever actually talked to the
   * address typed here. A proxy that refuses connections was only discovered
   * by a model download or a project upload failing a minute later, with a
   * message that named neither the proxy nor the address.
   */
  const testProxy = useCallback(async () => {
    if (!proxyUrl.trim()) {
      toast.warning(t('settings:httpsProxy.proxy'), {
        description: t('settings:httpsProxy.testNeedsUrl'),
      })
      return
    }
    setTesting(true)
    try {
      // Built from the form rather than from `downloadProxyConfig()`, which
      // returns nothing until the proxy is switched on — testing before
      // enabling is exactly when this is most useful. Otherwise it is the same
      // payload the downloader sends, credentials and no-proxy list included,
      // so a pass here means downloads pass.
      const noProxy = noProxyList
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
      const config: Record<string, string | string[] | boolean> = {
        url: proxyUrl.trim(),
        ignore_ssl: proxyIgnoreSSL,
      }
      if (proxyUsername && proxyPassword) {
        config.username = proxyUsername
        config.password = proxyPassword
      }
      if (noProxy.length > 0) config.no_proxy = noProxy
      const result = await invoke<ProxyTestResult>('test_proxy_connection', {
        config,
      })
      switch (result.kind) {
        case 'ok':
          toast.success(t('settings:httpsProxy.testOk'), {
            description: t('settings:httpsProxy.testOkDesc', {
              proxyUrl: proxyUrl.trim(),
              detail: result.detail,
            }),
          })
          break
        case 'bypassed':
          toast.warning(t('settings:httpsProxy.testBypassed'), {
            description: t('settings:httpsProxy.testBypassedDesc'),
          })
          break
        case 'auth_failed':
          toast.error(t('settings:httpsProxy.testAuthFailed'), {
            description: t('settings:httpsProxy.testAuthFailedDesc'),
            duration: 30000,
          })
          break
        case 'invalid_config':
          toast.error(t('settings:httpsProxy.testInvalid'), {
            description: result.detail,
            duration: 30000,
          })
          break
        case 'http_error':
          toast.error(t('settings:httpsProxy.testHttpError'), {
            description: result.detail,
            duration: 30000,
          })
          break
        default:
          toast.error(t('settings:httpsProxy.testUnreachable'), {
            description: t('settings:httpsProxy.testUnreachableDesc', {
              proxyUrl: proxyUrl.trim(),
            }),
            duration: 30000,
          })
      }
    } catch (error) {
      toast.error(t('settings:httpsProxy.testUnreachable'), {
        description: error instanceof Error ? error.message : String(error),
        duration: 30000,
      })
    } finally {
      setTesting(false)
    }
  }, [
    proxyUrl,
    proxyUsername,
    proxyPassword,
    proxyIgnoreSSL,
    noProxyList,
    t,
  ])

  return (
    <div className="flex flex-col h-svh w-full">
      <HeaderPage>
        <div className="flex items-center gap-2 w-full">
          <span className='font-medium text-base font-studio'>{t('common:settings')}</span>
        </div>
      </HeaderPage>
      <div className="flex h-[calc(100%-60px)]">
        <SettingsMenu />
        <div className="p-4 pt-0 w-full overflow-y-auto">
          <div className="flex flex-col justify-between gap-4 gap-y-3 w-full">
            {/* Proxy Configuration */}
            <Card
              header={
                <div className="flex items-center justify-between">
                  <h1 className="text-foreground font-studio font-medium text-base mb-2">
                    {t('settings:httpsProxy.proxy')}
                  </h1>
                  <Switch
                    checked={proxyEnabled}
                    onCheckedChange={toggleProxy}
                  />
                </div>
              }
            >
              <CardItem
                title={t('settings:httpsProxy.proxyUrl')}
                className="block"
                description={
                  <div className="space-y-2">
                    <p>{t('settings:httpsProxy.proxyUrlDesc')}</p>
                    <div className="flex gap-2">
                      <Input
                        className="w-full"
                        placeholder={t(
                          'settings:httpsProxy.proxyUrlPlaceholder'
                        )}
                        value={proxyUrl}
                        onChange={(e) => setProxyUrl(e.target.value)}
                      />
                      <Button
                        variant="secondary"
                        size="sm"
                        className="shrink-0"
                        onClick={testProxy}
                        disabled={testing}
                      >
                        {testing && (
                          <IconLoader
                            size={16}
                            className="animate-spin text-muted-foreground"
                          />
                        )}
                        <span>
                          {testing
                            ? t('settings:httpsProxy.testing')
                            : t('settings:httpsProxy.test')}
                        </span>
                      </Button>
                    </div>
                  </div>
                }
              />
              <CardItem
                title={t('settings:httpsProxy.authentication')}
                className="block"
                description={
                  <div className="space-y-2">
                    <p>{t('settings:httpsProxy.authenticationDesc')}</p>
                    <div className="flex gap-2">
                      <Input
                        placeholder={t('settings:httpsProxy.username')}
                        value={proxyUsername}
                        onChange={(e) => setProxyUsername(e.target.value)}
                      />
                      <div className="relative shrink-0 w-1/2">
                        <Input
                          type={showPassword ? 'text' : 'password'}
                          placeholder={t('settings:httpsProxy.password')}
                          className="pr-16"
                          value={proxyPassword}
                          onChange={(e) => setProxyPassword(e.target.value)}
                        />
                        <div className="absolute right-2 top-1/2 transform -translate-y-1/2 flex items-center gap-1">
                          <button
                            onClick={() => setShowPassword(!showPassword)}
                            className="p-1 rounded hover:bg-foreground/5 text-foreground/70"
                          >
                            {showPassword ? (
                              <EyeOff size={16} />
                            ) : (
                              <Eye size={16} />
                            )}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                }
              />
              <CardItem
                title={t('settings:httpsProxy.noProxy')}
                className="block"
                description={
                  <div className="space-y-2">
                    <p>{t('settings:httpsProxy.noProxyDesc')}</p>
                    <Input
                      placeholder={t('settings:httpsProxy.noProxyPlaceholder')}
                      value={noProxyList}
                      onChange={(e) => setNoProxy(e.target.value)}
                    />
                  </div>
                }
              />
              <CardItem
                title={t('settings:httpsProxy.ignoreSsl')}
                description={t('settings:httpsProxy.ignoreSslDesc')}
                actions={
                  <Switch
                    checked={proxyIgnoreSSL}
                    onCheckedChange={(checked) => setProxyIgnoreSSL(checked)}
                  />
                }
              />
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
