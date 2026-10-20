import { Globe } from 'lucide-react'

import { ServerSettingRow } from '@/containers/server/ServerPageParts'
import type { RemoteAccessView } from '@/hooks/useRemoteAccess'
import { useTranslation } from '@/i18n/react-i18next-compat'

import { AccessCardHeader } from './AccessCardHeader'
import { AccessUrlRow } from './AccessUrlRow'
import { ApiKeyRow } from './ApiKeyRow'
import { NoKeyConfirmDialog } from './NoKeyConfirmDialog'

/**
 * Remote access: a Cloudflare quick tunnel in front of the Local API Server.
 * Presentational; everything it shows and does comes from `useRemoteAccess`.
 */
export function RemoteAccessCard({ remote }: { remote: RemoteAccessView }) {
  const { t } = useTranslation()

  return (
    <section
      className="sp-panel"
      aria-label={t('settings:remoteLan.remote.title')}
    >
      <AccessCardHeader
        icon={<Globe size={22} />}
        title={t('settings:remoteLan.remote.title')}
        description={t('settings:remoteLan.remote.description')}
        tone={remote.tone}
        stateLabel={t(remote.stateKey)}
        action={remote.action}
        startLabel={t('settings:remoteLan.remote.start')}
        stopLabel={t('settings:remoteLan.remote.stop')}
        busy={remote.busy}
        disabled={remote.disabled}
        onAction={remote.onAction}
        message={remote.message}
      />
      {remote.apiUrl && (
        <div className="sp-access-urls">
          <AccessUrlRow url={remote.apiUrl} kind="remote" />
          <p>{t('settings:remoteLan.remote.security')}</p>
          <p>{t('settings:remoteLan.remote.providerHint')}</p>
        </div>
      )}
      <ApiKeyRow
        apiKey={remote.apiKey}
        onGenerate={remote.generateKey}
        needsRestart={remote.keyNeedsRestart}
        restarting={remote.restarting}
        restartDisabled={remote.restartDisabled}
        onRestart={remote.restartServer}
      />
      <ServerSettingRow
        title={t('settings:remoteLan.remote.autoStartTitle')}
        description={t('settings:remoteLan.remote.autoStartDesc')}
      >
        <input
          type="checkbox"
          aria-label={t('settings:remoteLan.remote.autoStartTitle')}
          checked={remote.autoStart}
          onChange={(event) => remote.setAutoStart(event.target.checked)}
        />
      </ServerSettingRow>
      <NoKeyConfirmDialog
        open={remote.confirmOpen}
        onGenerateKey={remote.confirmGenerateKey}
        onStartWithoutKey={remote.confirmWithoutKey}
        onCancel={remote.cancelConfirm}
      />
    </section>
  )
}
