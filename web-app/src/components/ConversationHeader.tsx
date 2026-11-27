import { useEffect, type ReactNode } from 'react'
import HeaderPage from '@/containers/HeaderPage'
import { currentDesktopPlatform } from '@/constants/integrations'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { homeFor, useChatMode, type ChatMode } from '@/lib/pi/navigation'
import { cn } from '@/lib/utils'

function ModeSwitch({ mode }: { mode: ChatMode }) {
  const navigate = useNavigate()
  const { t } = useTranslation()
  return (
    <div
      role="group"
      aria-label={t('chat:pi.mode')}
      className="pointer-events-auto inline-grid max-w-full grid-cols-2 items-center rounded-full bg-muted p-0.5"
    >
      {(['chat', 'agent'] as const).map((value) => (
        <button
          type="button"
          key={value}
          aria-pressed={mode === value}
          className={cn(
            'min-w-0 truncate rounded-full px-4 py-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-w-20',
            mode === value && 'bg-background text-foreground shadow-sm'
          )}
          onClick={() =>
            mode !== value && void navigate({ to: homeFor(value) })
          }
        >
          {t(`chat:pi.${value}`)}
        </button>
      ))}
    </div>
  )
}

export default function ConversationHeader({
  children,
  mode,
  showModeSwitch = false,
}: {
  children?: ReactNode
  mode: ChatMode
  showModeSwitch?: boolean
}) {
  const desktop = Boolean(currentDesktopPlatform())
  useEffect(() => {
    if (desktop) useChatMode.getState().select(mode)
  }, [desktop, mode])
  return (
    <HeaderPage
      center={desktop && showModeSwitch && <ModeSwitch mode={mode} />}
    >
      {children}
    </HeaderPage>
  )
}
