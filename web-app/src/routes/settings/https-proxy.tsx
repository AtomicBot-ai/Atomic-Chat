import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import {
  ServerButton,
  ServerField,
  ServerPage,
  ServerSettingRow,
} from '@/containers/server/ServerPageParts'
import { useTranslation } from '@/i18n/react-i18next-compat'
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

/**
 * Server → HTTPS Proxy: the proxy downloads and uploads go through, laid out
 * like the section's other pages (`ServerPage`).
 */
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
    <ServerPage title={t('common:https_proxy')}>
      <section className="sp-panel" aria-label={t('settings:httpsProxy.proxy')}>
        <div className="sp-row">
          <h2>{t('settings:httpsProxy.proxy')}</h2>
          <input
            type="checkbox"
            aria-label={t('settings:httpsProxy.proxy')}
            checked={proxyEnabled}
            onChange={(event) => toggleProxy(event.target.checked)}
          />
        </div>
        <div className="mb-[18px] grid gap-[18px]">
          <div className="sp-field">
            <label htmlFor="https-proxy-url">
              {t('settings:httpsProxy.proxyUrl')}
            </label>
            <div className="sp-key-controls">
              <input
                id="https-proxy-url"
                spellCheck={false}
                placeholder={t('settings:httpsProxy.proxyUrlPlaceholder')}
                value={proxyUrl}
                onChange={(event) => setProxyUrl(event.target.value)}
              />
              <ServerButton onClick={testProxy} disabled={testing}>
                {testing && <IconLoader size={14} className="animate-spin" />}
                {testing
                  ? t('settings:httpsProxy.testing')
                  : t('settings:httpsProxy.test')}
              </ServerButton>
            </div>
            <small>{t('settings:httpsProxy.proxyUrlDesc')}</small>
          </div>
          <div
            className="sp-field"
            role="group"
            aria-label={t('settings:httpsProxy.authentication')}
          >
            <span>{t('settings:httpsProxy.authentication')}</span>
            <div className="sp-key-controls">
              <input
                aria-label={t('settings:httpsProxy.username')}
                autoComplete="off"
                spellCheck={false}
                placeholder={t('settings:httpsProxy.username')}
                value={proxyUsername}
                onChange={(event) => setProxyUsername(event.target.value)}
              />
              <div className="relative flex min-w-[160px] flex-[1_1_220px]">
                <input
                  type={showPassword ? 'text' : 'password'}
                  aria-label={t('settings:httpsProxy.password')}
                  autoComplete="off"
                  placeholder={t('settings:httpsProxy.password')}
                  className="pr-10"
                  value={proxyPassword}
                  onChange={(event) => setProxyPassword(event.target.value)}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-foreground/70 hover:bg-foreground/5"
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            <small>{t('settings:httpsProxy.authenticationDesc')}</small>
          </div>
          <ServerField
            label={t('settings:httpsProxy.noProxy')}
            hint={t('settings:httpsProxy.noProxyDesc')}
          >
            <input
              spellCheck={false}
              placeholder={t('settings:httpsProxy.noProxyPlaceholder')}
              value={noProxyList}
              onChange={(event) => setNoProxy(event.target.value)}
            />
          </ServerField>
        </div>
        <ServerSettingRow
          title={t('settings:httpsProxy.ignoreSsl')}
          description={t('settings:httpsProxy.ignoreSslDesc')}
        >
          <input
            type="checkbox"
            aria-label={t('settings:httpsProxy.ignoreSsl')}
            checked={proxyIgnoreSSL}
            onChange={(event) => setProxyIgnoreSSL(event.target.checked)}
          />
        </ServerSettingRow>
      </section>
    </ServerPage>
  )
}
