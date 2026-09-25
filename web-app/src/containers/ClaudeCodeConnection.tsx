import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Card } from '@/containers/Card'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  CLAUDE_CODE_PROVIDER,
  claudeCodeProvider,
  loginClaudeCode,
  type ClaudeCodeStatus,
} from '@/lib/claude-code-chat'

type CardProps = {
  status?: ClaudeCodeStatus
  busy?: 'checking' | 'connecting' | null
  error?: string
  enabled: boolean
  onEnabled: (active: boolean) => void
  onConnect: () => void
  onCancel: () => void
  onRefresh: () => void
  onInstall: () => void
}

export function ClaudeCodeConnectionCard({
  status,
  busy,
  error,
  enabled,
  onEnabled,
  onConnect,
  onCancel,
  onRefresh,
  onInstall,
}: CardProps) {
  const { t } = useTranslation()
  const label = busy
    ? t(`cloud:claudeCode.${busy}`)
    : error && !status
      ? t('cloud:claudeCode.unavailable')
      : status?.subscription
        ? t('cloud:claudeCode.connected', { plan: status.plan ?? 'Claude' })
        : status?.installed
          ? t(
              status.loggedIn
                ? 'cloud:claudeCode.apiAccount'
                : 'cloud:claudeCode.signInNeeded'
            )
          : t('cloud:claudeCode.installNeeded')
  return (
    <Card>
      <div
        data-testid="claude-connection-card"
        className="min-w-0 space-y-4 break-words"
      >
        <div className="flex min-w-0 items-center justify-between gap-3">
          <h2 className="min-w-0 font-studio text-base font-medium text-foreground">
            {t('cloud:claudeCode.title')}
          </h2>
          <Switch
            className="shrink-0"
            aria-label={t('cloud:claudeCode.enable')}
            checked={enabled}
            onCheckedChange={onEnabled}
          />
        </div>
        <p>{t('cloud:claudeCode.description')}</p>
        <div role="status" className="min-h-12 text-foreground">
          {label}
        </div>
        {status?.version && <p className="text-xs">{status.version}</p>}
        {(error || status?.error) && (
          <p role="alert" className="text-destructive">
            {error || status?.error}
          </p>
        )}
        <div className="flex min-w-0 flex-wrap gap-2 [&>button]:h-auto [&>button]:max-w-full [&>button]:whitespace-normal [&>button]:py-2">
          {busy === 'connecting' ? (
            <Button variant="outline" onClick={onCancel}>
              {t('common:cancel')}
            </Button>
          ) : (
            status?.installed && (
              <Button onClick={onConnect} disabled={Boolean(busy)}>
                {t('cloud:claudeCode.connect')}
              </Button>
            )
          )}
          <Button
            variant="outline"
            onClick={onRefresh}
            disabled={Boolean(busy)}
          >
            {t('cloud:claudeCode.check')}
          </Button>
          <Button variant="outline" onClick={onInstall}>
            {t('cloud:claudeCode.install')}
          </Button>
        </div>
        <p className="text-sm">{t('cloud:claudeCode.limits')}</p>
      </div>
    </Card>
  )
}

export default function ClaudeCodeConnection({
  onConnected,
}: {
  onConnected?: (modelId: string) => void
}) {
  const [status, setStatus] = useState<ClaudeCodeStatus>()
  const [busy, setBusy] = useState<CardProps['busy']>('checking')
  const [error, setError] = useState('')
  const loginAbort = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  const completed = useRef(false)
  const provider = useModelProvider((s) =>
    s.providers.find((p) => p.provider === CLAUDE_CODE_PROVIDER)
  )
  const updateProvider = useModelProvider((s) => s.updateProvider)
  const serviceHub = useServiceHub()
  const refresh = useCallback(async () => {
    setBusy('checking')
    setError('')
    try {
      const next = await invoke<ClaudeCodeStatus>('atomic_claude_status')
      updateProvider(CLAUDE_CODE_PROVIDER, {
        models: next.subscription ? claudeCodeProvider(next.models).models : [],
      })
      if (mounted.current) setStatus(next)
    } catch (err) {
      updateProvider(CLAUDE_CODE_PROVIDER, { models: [] })
      if (mounted.current) {
        setStatus(undefined)
        setError(String(err))
      }
    } finally {
      if (mounted.current) setBusy(null)
    }
  }, [updateProvider])
  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => {
      mounted.current = false
      loginAbort.current?.abort()
    }
  }, [refresh])
  useEffect(() => {
    if (
      !completed.current &&
      onConnected &&
      status?.subscription &&
      status.models[0]
    ) {
      completed.current = true
      updateProvider(CLAUDE_CODE_PROVIDER, { active: true })
      onConnected(status.models[0].id)
    }
  }, [onConnected, status, updateProvider])
  const login = async () => {
    setBusy('connecting')
    setError('')
    const controller = new AbortController()
    loginAbort.current = controller
    try {
      await loginClaudeCode(controller.signal)
      updateProvider(CLAUDE_CODE_PROVIDER, { active: true })
      if (mounted.current) await refresh()
    } catch (err) {
      if (mounted.current && !controller.signal.aborted) setError(String(err))
    } finally {
      if (mounted.current) setBusy(null)
      loginAbort.current = null
    }
  }
  return (
    <ClaudeCodeConnectionCard
      status={status}
      busy={busy}
      error={error}
      enabled={provider?.active ?? false}
      onEnabled={(active) => updateProvider(CLAUDE_CODE_PROVIDER, { active })}
      onConnect={() => void login()}
      onCancel={() => loginAbort.current?.abort()}
      onRefresh={() => void refresh()}
      onInstall={() =>
        void serviceHub.opener().open('https://code.claude.com/docs/en/setup')
      }
    />
  )
}
