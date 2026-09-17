import { IconLoader2 } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import { ApiKeyInput } from '@/containers/ApiKeyInput'
import { CardItem } from '@/containers/Card'
import { CopyButton } from '@/containers/CopyButton'
import { useTranslation } from '@/i18n/react-i18next-compat'

/**
 * The Local API Server's key, where the decision to expose the server is made.
 *
 * Always visible and always editable, unlike the same field on the API screen:
 * the point of this page is to put a key in place before — or while — the API
 * is reachable from outside. The server reads the key once, when it starts, so
 * a change made while it runs comes with the restart that applies it.
 */
export function ApiKeyRow({
  apiKey,
  onGenerate,
  needsRestart,
  restarting,
  restartDisabled,
  onRestart,
}: {
  apiKey: string
  onGenerate: () => void
  needsRestart: boolean
  restarting: boolean
  restartDisabled: boolean
  onRestart: () => void
}) {
  const { t } = useTranslation()

  return (
    <CardItem
      title={t('settings:remoteLan.apiKey.title')}
      className="block"
      description={
        <div className="space-y-2">
          <p>{t('settings:remoteLan.apiKey.description')}</p>
          <div className="flex items-center gap-2">
            <ApiKeyInput />
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={onGenerate}
            >
              {t('settings:remoteLan.apiKey.generate')}
            </Button>
            {apiKey.trim() !== '' && (
              <CopyButton
                text={apiKey}
                ariaLabel={t('settings:remoteLan.apiKey.copy')}
              />
            )}
          </div>
          {needsRestart && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs">
                {t('settings:remoteLan.apiKey.restartToApply')}
              </p>
              <Button
                variant="outline"
                size="xs"
                className="shrink-0"
                disabled={restartDisabled}
                onClick={onRestart}
              >
                {restarting && <IconLoader2 className="animate-spin" />}
                {t('settings:remoteLan.apiKey.restartServer')}
              </Button>
            </div>
          )}
        </div>
      }
    />
  )
}
