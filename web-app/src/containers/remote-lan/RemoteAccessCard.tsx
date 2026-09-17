import { IconWorld } from '@tabler/icons-react'

import { Switch } from '@/components/ui/switch'
import { Card, CardItem } from '@/containers/Card'
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
    <section aria-label={t('settings:remoteLan.remote.title')}>
      <Card
        header={
          <AccessCardHeader
            icon={<IconWorld size={18} />}
            title={t('settings:remoteLan.remote.title')}
            description={t('settings:remoteLan.remote.description')}
            tone={remote.tone}
            stateLabel={t(remote.stateKey)}
            action={remote.action}
            busy={remote.busy}
            disabled={remote.disabled}
            onAction={remote.onAction}
            message={remote.message}
          />
        }
      >
        {remote.apiUrl && (
          <CardItem
            title={t('settings:remoteLan.remote.urlLabel')}
            className="block"
            description={
              <div className="space-y-2">
                <AccessUrlRow url={remote.apiUrl} kind="remote" />
                <p>{t('settings:remoteLan.remote.security')}</p>
                <p>{t('settings:remoteLan.remote.providerHint')}</p>
              </div>
            }
          />
        )}
        <ApiKeyRow
          apiKey={remote.apiKey}
          onGenerate={remote.generateKey}
          needsRestart={remote.keyNeedsRestart}
          restarting={remote.restarting}
          restartDisabled={remote.restartDisabled}
          onRestart={remote.restartServer}
        />
        <CardItem
          title={t('settings:remoteLan.autoStart')}
          description={t('settings:remoteLan.remote.autoStartDesc')}
          actions={
            <Switch
              aria-label={t('settings:remoteLan.autoStart')}
              checked={remote.autoStart}
              onCheckedChange={remote.setAutoStart}
            />
          }
        />
      </Card>
      <NoKeyConfirmDialog
        open={remote.confirmOpen}
        onGenerateKey={remote.confirmGenerateKey}
        onStartWithoutKey={remote.confirmWithoutKey}
        onCancel={remote.cancelConfirm}
      />
    </section>
  )
}
