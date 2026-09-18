import { IconLoader2 } from '@tabler/icons-react'
import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import {
  StatusDot,
  type StatusTone,
} from '@/containers/api/ApiStatusIndicators'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { AccessAction, AccessMessage } from '@/lib/remoteLan'

const MESSAGE_TONE: Record<AccessMessage['tone'], string> = {
  muted: 'text-muted-foreground',
  warning: 'text-amber-600 dark:text-amber-400',
  destructive: 'text-destructive',
}

/**
 * Top of both cards on Settings → Remote & LAN: what it is, the state it is in,
 * the one action, and the one line that explains the state.
 *
 * The action is a button rather than a `Switch` on purpose. It is asynchronous
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
          ? t('settings:remoteLan.stop')
          : t('settings:remoteLan.start')

  return (
    <div className="border-b border-border/40 pb-3">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-secondary text-foreground">
          {icon}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="text-foreground font-studio font-medium text-base">
              {title}
            </h1>
            <output
              aria-live="polite"
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              <StatusDot tone={tone} />
              {stateLabel}
            </output>
          </div>
          <p className="leading-normal text-muted-foreground">{description}</p>
        </div>
        <Button
          size="sm"
          variant={action === 'stop' ? 'destructive' : 'default'}
          className="shrink-0"
          disabled={disabled}
          onClick={onAction}
        >
          {busy !== null && <IconLoader2 size={14} className="animate-spin" />}
          {actionLabel}
        </Button>
      </div>
      {(message || notes.length > 0) && (
        <div className="mt-3 space-y-1.5 text-xs leading-normal">
          {message && (
            <p
              role={message.tone === 'destructive' ? 'alert' : undefined}
              className={MESSAGE_TONE[message.tone]}
            >
              {t(message.key, message.params)}
            </p>
          )}
          {notes.map((note) => (
            <p key={note} className="text-muted-foreground">
              {note}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}
