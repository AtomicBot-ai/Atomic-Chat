import { Wifi } from 'lucide-react'

import { ServerSettingRow } from '@/containers/server/ServerPageParts'
import type { LanAccessView } from '@/hooks/useLanAccess'
import { useTranslation } from '@/i18n/react-i18next-compat'

import { AccessCardHeader } from './AccessCardHeader'
import { AccessUrlRow } from './AccessUrlRow'

/**
 * Local network access: the Local API Server bound on every interface, with
 * the addresses other devices can dial. Presentational; see `useLanAccess`.
 */
export function LanAccessCard({ lan }: { lan: LanAccessView }) {
  const { t } = useTranslation()

  // Both are about what the button is going to do, so they sit next to it.
  const notes = [
    lan.showRestartNote && t('settings:remoteLan.lan.restartNote'),
    lan.showFirewallHint && t('settings:remoteLan.lan.windowsFirewallHint'),
  ].filter((note): note is string => Boolean(note))

  return (
    <section
      className="sp-panel"
      aria-label={t('settings:remoteLan.lan.title')}
    >
      <AccessCardHeader
        icon={<Wifi size={22} />}
        title={t('settings:remoteLan.lan.title')}
        description={t('settings:remoteLan.lan.description')}
        tone={lan.tone}
        stateLabel={t(lan.stateKey)}
        action={lan.action}
        startLabel={t('settings:remoteLan.lan.start')}
        stopLabel={t('settings:remoteLan.lan.stop')}
        busy={lan.busy}
        disabled={lan.disabled}
        onAction={lan.onAction}
        message={lan.message}
        notes={notes}
      />
      {lan.urls.length > 0 && (
        <div className="sp-access-urls">
          {lan.urls.map((url) => (
            <AccessUrlRow key={url} url={url} kind="lan" />
          ))}
          <p>{t('settings:remoteLan.lan.security')}</p>
        </div>
      )}
      <ServerSettingRow
        title={t('settings:remoteLan.lan.autoStartTitle')}
        description={t('settings:remoteLan.lan.autoStartDesc')}
      >
        <input
          type="checkbox"
          aria-label={t('settings:remoteLan.lan.autoStartTitle')}
          checked={lan.autoStart}
          onChange={(event) => lan.setAutoStart(event.target.checked)}
        />
      </ServerSettingRow>
    </section>
  )
}
