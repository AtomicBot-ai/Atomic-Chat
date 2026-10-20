import { ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useLocalApiServerControl } from '@/hooks/useLocalApiServerControl'
import { restartLocalApiServer } from '@/hooks/useRemoteAccess'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { generateLocalApiKey } from '@/lib/localApiKey'
import { queuedCapture } from '@/lib/telemetry-queue'

import {
  ServerApiKeyField,
  ServerButton,
  ServerField,
  ServerSettingRow,
} from './ServerPageParts'

/** The form's own copy of the server settings, as the fields hold them. */
export type ServerConfigDraft = {
  host: '127.0.0.1' | '0.0.0.0'
  port: string
  prefix: string
  apiKey: string
  autoStart: boolean
  timeout: string
  trustedHosts: string
}

/** The settings the running server read when it started. */
const RESTART_FIELDS = [
  'host',
  'port',
  'prefix',
  'apiKey',
  'timeout',
  'trustedHosts',
] as const satisfies readonly (keyof ServerConfigDraft)[]

type StoreFields = Pick<
  ReturnType<typeof useLocalApiServer.getState>,
  | 'serverHost'
  | 'serverPort'
  | 'apiPrefix'
  | 'apiKey'
  | 'enableOnStartup'
  | 'proxyTimeout'
  | 'trustedHosts'
>

const draftFromStore = (state: StoreFields): ServerConfigDraft => ({
  host: state.serverHost,
  port: String(state.serverPort),
  prefix: state.apiPrefix,
  apiKey: state.apiKey,
  autoStart: state.enableOnStartup,
  timeout: String(state.proxyTimeout),
  trustedHosts: state.trustedHosts.join(', '),
})

const sameDraft = (a: ServerConfigDraft, b: ServerConfigDraft) =>
  (Object.keys(a) as (keyof ServerConfigDraft)[]).every(
    (key) => a[key] === b[key]
  )

/** Comma-separated hosts, trimmed, empty entries and repeats dropped. */
export const parseTrustedHosts = (text: string) => [
  ...new Set(
    text
      .split(',')
      .map((host) => host.trim())
      .filter(Boolean)
  ),
]

const isWholeNumber = (text: string) => /^\d+$/.test(text.trim())

/** A port from 1 to 65535, a prefix starting with `/`, a 0–86400 s timeout. */
export function isValidServerConfig(draft: ServerConfigDraft): boolean {
  return (
    isWholeNumber(draft.port) &&
    Number(draft.port) >= 1 &&
    Number(draft.port) <= 65535 &&
    /^\/[\w/-]*$/.test(draft.prefix.trim()) &&
    isWholeNumber(draft.timeout) &&
    Number(draft.timeout) <= 86400
  )
}

const normalize = (draft: ServerConfigDraft): ServerConfigDraft => ({
  ...draft,
  port: String(Number(draft.port)),
  prefix: draft.prefix.trim(),
  timeout: String(Number(draft.timeout)),
  trustedHosts: parseTrustedHosts(draft.trustedHosts).join(', '),
})

type Phase = 'idle' | 'saved' | 'restarting' | 'failed'

/**
 * Server → Configuration. The fields edit a draft; "Save changes" writes it to
 * `useLocalApiServer`, and while the server runs "Apply & restart" also
 * restarts it when a setting it read at start changed (autostart alone does
 * not need one). A change made elsewhere — Remote access generating a key —
 * flows in as long as the draft has no edits of its own.
 */
export function ServerConfiguration() {
  const { t } = useTranslation()
  const hub = useServiceHub()
  const control = useLocalApiServerControl()
  const stored = useLocalApiServer(useShallow(draftFromStore))

  const [baseline, setBaseline] = useState(stored)
  const [draft, setDraft] = useState(stored)
  const [phase, setPhase] = useState<Phase>('idle')

  // The store moved under the form: follow it unless the user is editing.
  if (!sameDraft(stored, baseline)) {
    if (sameDraft(draft, baseline)) setDraft(stored)
    setBaseline(stored)
  }

  const dirty = !sameDraft(draft, baseline)
  const valid = isValidServerConfig(draft)
  const restarting = phase === 'restarting'

  const update = <K extends keyof ServerConfigDraft>(
    key: K,
    value: ServerConfigDraft[K]
  ) => {
    setDraft((current) => ({ ...current, [key]: value }))
    setPhase('idle')
  }

  const save = async () => {
    if (!dirty || !valid || restarting) return
    const next = normalize(draft)
    const before = normalize(baseline)
    const needsRestart =
      control.isRunning &&
      RESTART_FIELDS.some((key) => next[key] !== before[key])

    const store = useLocalApiServer.getState()
    store.setServerHost(next.host)
    store.setServerPort(Number(next.port))
    store.setApiPrefix(next.prefix)
    store.setApiKey(next.apiKey)
    store.setEnableOnStartup(next.autoStart)
    store.setProxyTimeout(Number(next.timeout))
    store.setTrustedHosts(parseTrustedHosts(next.trustedHosts))
    setDraft(next)

    if (!needsRestart) {
      setPhase('saved')
      return
    }
    setPhase('restarting')
    const running = await restartLocalApiServer(hub, control)
    setPhase(running ? 'saved' : 'failed')
  }

  const statusText = restarting
    ? t('settings:serverConfig.restarting')
    : phase === 'failed'
      ? t('settings:serverConfig.restartFailed')
      : phase === 'saved' && !dirty
        ? t('settings:serverConfig.saved')
        : dirty
          ? t('settings:serverConfig.unsaved')
          : t('settings:serverConfig.allSaved')

  return (
    <>
      <section className="sp-panel">
        <h2>{t('settings:serverConfig.panelTitle')}</h2>
        <ServerField label={t('settings:serverConfig.host')}>
          <select
            value={draft.host}
            onChange={(event) =>
              update('host', event.target.value as ServerConfigDraft['host'])
            }
          >
            <option value="127.0.0.1">
              {t('settings:serverConfig.hostLocal')}
            </option>
            <option value="0.0.0.0">
              {t('settings:serverConfig.hostNetwork')}
            </option>
          </select>
        </ServerField>
        <div className="sp-fields">
          <ServerField label={t('settings:serverConfig.port')}>
            <input
              value={draft.port}
              inputMode="numeric"
              onChange={(event) => update('port', event.target.value)}
            />
          </ServerField>
          <ServerField label={t('settings:serverConfig.prefix')}>
            <input
              value={draft.prefix}
              spellCheck={false}
              onChange={(event) => update('prefix', event.target.value)}
            />
          </ServerField>
        </div>
        <ServerApiKeyField
          id="server-config-api-key"
          value={draft.apiKey}
          onChange={(value) => update('apiKey', value)}
          onGenerate={() => {
            update('apiKey', generateLocalApiKey())
            queuedCapture('local_api_key_generate', {
              generate_source: 'server_configuration',
            })
          }}
        />
        <ServerSettingRow
          title={t('settings:serverConfig.autoStart')}
          description={t('settings:serverConfig.autoStartDesc')}
        >
          <input
            type="checkbox"
            aria-label={t('settings:serverConfig.autoStart')}
            checked={draft.autoStart}
            onChange={(event) => update('autoStart', event.target.checked)}
          />
        </ServerSettingRow>
      </section>

      <details className="sp-panel">
        <summary>
          {t('settings:serverConfig.advanced')}
          <ChevronDown size={16} />
        </summary>
        <div className="sp-fields">
          <ServerField
            label={t('settings:serverConfig.timeout')}
            hint={t('settings:serverConfig.timeoutHint')}
          >
            <input
              value={draft.timeout}
              inputMode="numeric"
              onChange={(event) => update('timeout', event.target.value)}
            />
          </ServerField>
          <ServerField
            label={t('settings:serverConfig.trustedHosts')}
            hint={t('settings:serverConfig.trustedHostsHint')}
          >
            <input
              value={draft.trustedHosts}
              spellCheck={false}
              onChange={(event) => update('trustedHosts', event.target.value)}
            />
          </ServerField>
        </div>
      </details>

      <div className="sp-save">
        {/* Why Save is off sits next to it, where the sticky bar keeps it in view. */}
        {valid ? (
          <span role="status">{statusText}</span>
        ) : (
          <span role="alert" className="sp-error">
            {t('settings:serverConfig.invalid')}
          </span>
        )}
        <ServerButton
          disabled={!dirty || restarting}
          onClick={() => {
            setDraft(baseline)
            setPhase('idle')
          }}
        >
          {t('settings:serverConfig.discard')}
        </ServerButton>
        <ServerButton
          primary
          disabled={!dirty || !valid || restarting || control.isBusy}
          onClick={() => void save()}
        >
          {control.isRunning
            ? t('settings:serverConfig.applyRestart')
            : t('settings:serverConfig.save')}
        </ServerButton>
      </div>
    </>
  )
}
