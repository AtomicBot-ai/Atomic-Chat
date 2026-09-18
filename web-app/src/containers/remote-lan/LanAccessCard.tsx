import { IconWifi } from '@tabler/icons-react'

import { Switch } from '@/components/ui/switch'
import { Card, CardItem } from '@/containers/Card'
import type { LanAccessView } from '@/hooks/useLanAccess'
import { useTranslation } from '@/i18n/react-i18next-compat'

import { AccessCardHeader } from './AccessCardHeader'
import { AccessUrlRow } from './AccessUrlRow'

/**
 * LAN access: the Local API Server bound on every interface, with the
 * addresses other devices can dial. Presentational; see `useLanAccess`.
 */
export function LanAccessCard({ lan }: { lan: LanAccessView }) {
  const { t } = useTranslation()

  // Both are about what the button is going to do, so they sit next to it.
  const notes = [
    lan.showRestartNote && t('settings:remoteLan.lan.restartNote'),
    lan.showFirewallHint && t('settings:remoteLan.lan.windowsFirewallHint'),
  ].filter((note): note is string => Boolean(note))

  return (
    <section aria-label={t('settings:remoteLan.lan.title')}>
      <Card
        header={
          <AccessCardHeader
            icon={<IconWifi size={18} />}
            title={t('settings:remoteLan.lan.title')}
            description={t('settings:remoteLan.lan.description')}
            tone={lan.tone}
            stateLabel={t(lan.stateKey)}
            action={lan.action}
            busy={lan.busy}
            disabled={lan.disabled}
            onAction={lan.onAction}
            message={lan.message}
            notes={notes}
          />
        }
      >
        {lan.urls.length > 0 && (
          <CardItem
            title={t(
              lan.urls.length === 1
                ? 'settings:remoteLan.lan.addressLabel'
                : 'settings:remoteLan.lan.addressesLabel'
            )}
            className="block"
            description={
              <div className="space-y-2">
                {lan.urls.map((url) => (
                  <AccessUrlRow key={url} url={url} kind="lan" />
                ))}
                <p>{t('settings:remoteLan.lan.security')}</p>
              </div>
            }
          />
        )}
        <CardItem
          title={t('settings:remoteLan.autoStart')}
          description={t('settings:remoteLan.lan.autoStartDesc')}
          actions={
            <Switch
              aria-label={t('settings:remoteLan.autoStart')}
              checked={lan.autoStart}
              onCheckedChange={lan.setAutoStart}
            />
          }
        />
      </Card>
    </section>
  )
}
