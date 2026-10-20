import { IconLoader2 } from '@tabler/icons-react'
import { useState } from 'react'

import {
  ServerApiKeyField,
  ServerButton,
} from '@/containers/server/ServerPageParts'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useTranslation } from '@/i18n/react-i18next-compat'

/**
 * The Local API Server's key, where the decision to expose the server is made.
 *
 * Always editable: the point of this card is to put a key in place before —
 * or while — the API is reachable from outside. A typed key is kept when the
 * field loses focus; Generate keeps one at once. The server reads the key
 * once, when it starts, so a change made while it runs comes with the restart
 * that applies it.
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
  const setApiKey = useLocalApiServer((state) => state.setApiKey)
  const [value, setValue] = useState(apiKey)
  const [stored, setStored] = useState(apiKey)

  // A key generated here or saved on Configuration replaces the text.
  if (apiKey !== stored) {
    setStored(apiKey)
    setValue(apiKey)
  }

  return (
    <>
      <ServerApiKeyField
        id="remote-access-api-key"
        value={value}
        onChange={setValue}
        onBlur={() => {
          if (value !== apiKey) setApiKey(value)
        }}
        onGenerate={onGenerate}
      />
      {needsRestart && (
        <div className="sp-key-restart">
          <p>{t('settings:remoteLan.apiKey.restartToApply')}</p>
          <ServerButton disabled={restartDisabled} onClick={onRestart}>
            {restarting && <IconLoader2 size={14} className="animate-spin" />}
            {t('settings:remoteLan.apiKey.restartServer')}
          </ServerButton>
        </div>
      )}
    </>
  )
}
