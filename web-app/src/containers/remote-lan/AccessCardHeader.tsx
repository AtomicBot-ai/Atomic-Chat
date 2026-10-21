import { IconLoader2 } from '@tabler/icons-react'
import type { ReactNode } from 'react'

import {
  StatusDot,
  type StatusTone,
} from '@/containers/api/ApiStatusIndicators'
import { ServerButton } from '@/containers/server/ServerPageParts'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { AccessAction, AccessMessage } from '@/lib/remoteLan'

const MESSAGE_TONE: Record<AccessMessage['tone'], string> = {
  muted: 'text-muted-foreground',
  warning: 'text-amber-600 dark:text-amber-400',
  destructive: 'text-destructive',
}

/**
 * Top of the Remote access and Local network cards: what it is, the state it
 * is in, the one action, and the lines that explain the state.
 *
 * The action is a button rather than a switch on purpose. It is asynchronous
 * and it can fail; a switch would have to show "on" before anything is, or
 * jump back on its own.
 */
export function AccessCardHeader({
  icon,
  title,
  description,
  tone,
  stateLabel,
  action,
  startLabel,
  stopLabel,
  busy,
  disabled,
  onAction,
  message,
  notes = [],
}: {
  icon: ReactNode
  title: string
  description: string
  tone: StatusTone
  stateLabel: string
  action: AccessAction
  startLabel: string
  stopLabel: string
  busy: AccessAction | null
  disabled: boolean
  onAction: () => void
  message: AccessMessage | null
  /** Standing remarks about what the action will do. */
  notes?: string[]
}) {
  const { t } = useTranslation()

  const actionLabel =
    busy === 'start'
      ? t('settings:remoteLan.starting')
      : busy === 'stop'
        ? t('settings:remoteLan.stopping')
        : action === 'stop'
          ? stopLabel
          : startLabel

  return (
    <>
      <div className="sp-access-heading">
        <span className="shrink-0 text-foreground" aria-hidden="true">
          {icon}
        </span>
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <output aria-live="polite" className="sp-status">
          <StatusDot tone={tone} />
          {stateLabel}
        </output>
        <ServerButton disabled={disabled} onClick={onAction}>
          {busy !== null && <IconLoader2 size={14} className="animate-spin" />}
          {actionLabel}
        </ServerButton>
      </div>
      {(message || notes.length > 0) && (
        <div className="sp-access-notes">
          {message && (
            <p
              role={message.tone === 'destructive' ? 'alert' : undefined}
              className={MESSAGE_TONE[message.tone]}
            >
              {t(message.key, message.params)}
            </p>
          )}
          {notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </div>
      )}
    </>
  )
}
