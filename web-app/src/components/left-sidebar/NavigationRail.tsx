import { useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import {
  Blocks,
  CircleHelp,
  Github,
  Mail,
  MessageCircle,
  RadioTower,
  Settings,
} from 'lucide-react'
import { IconBrandDiscord } from '@tabler/icons-react'
import { cn } from '@/lib/utils'
import type { NavigationSection } from '@/lib/navigation'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useSidebar } from '@/components/ui/sidebar'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { SupportChatSheet } from '@/containers/support/SupportChatSheet'
import { useSupportChatStore } from '@/stores/support-chat-store'

const DISCORD_URL = 'https://discord.com/invite/8wGSsvmg4V'
const NEW_ISSUE_URL = 'https://github.com/AtomicBot-ai/Atomic-Chat/issues/new'
const SUPPORT_EMAIL = 'mailto:support@atomic.chat'

const railButton =
  'flex size-10 items-center justify-center rounded-xl text-sidebar-foreground/60 transition-colors hover:bg-sidebar-foreground/8 hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

const helpItem =
  'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm hover:bg-foreground/8 focus-visible:bg-foreground/8 focus-visible:outline-none [&>svg]:shrink-0 [&>svg]:opacity-70'

export function NavigationRail({ section }: { section: NavigationSection }) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const [helpOpen, setHelpOpen] = useState(false)
  const setSupportOpen = useSupportChatStore((state) => state.setSheetOpen)
  const { setOpen, setOpenMobile, isMobile } = useSidebar()
  // Picking a section always shows its sidebar, even if it was collapsed.
  const reveal = () => (isMobile ? setOpenMobile(true) : setOpen(true))

  const openExternal = async (target: string) => {
    setHelpOpen(false)
    try {
      await serviceHub.opener().open(target)
    } catch (error) {
      console.error('Failed to open help link:', error)
      window.open(target, '_blank')
    }
  }

  const item = (
    id: NavigationSection,
    label: string,
    to: string,
    icon: ReactNode
  ) => (
    <Tooltip key={id}>
      <TooltipTrigger asChild>
        <Link
          to={to}
          aria-label={label}
          aria-current={section === id ? 'page' : undefined}
          data-testid={`rail-${id}`}
          onClick={reveal}
          className={cn(
            railButton,
            section === id &&
              'bg-sidebar-foreground/15 text-sidebar-foreground shadow-xs'
          )}
        >
          {icon}
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={12}>
        {label}
      </TooltipContent>
    </Tooltip>
  )

  const openSupportChat = () => {
    setHelpOpen(false)
    setSupportOpen(true)
  }

  return (
    <nav
      aria-label={t('common:navigation.primary')}
      className="sticky top-0 z-40 flex h-svh w-(--navigation-rail-width) shrink-0 flex-col items-center border-r border-sidebar-border/60 bg-background py-3"
    >
      <div
        className="mb-5 flex size-10 shrink-0 items-center justify-center"
        title="Atomic Chat"
      >
        <img
          src="/images/transparent-logo.png"
          alt="Atomic Chat"
          draggable={false}
          className="pointer-events-none size-8 select-none object-contain brightness-0 dark:invert"
        />
      </div>
      <div className="flex flex-col gap-3">
        {item(
          'chat',
          t('common:navigation.workspace'),
          route.home,
          <MessageCircle size={20} strokeWidth={1.7} />
        )}
        {item(
          'server',
          t('common:navigation.server'),
          route.api.index,
          <RadioTower size={20} strokeWidth={1.7} />
        )}
        {item(
          'models',
          t('common:navigation.modelsHub'),
          route.hub.index,
          <Blocks size={20} strokeWidth={1.7} />
        )}
      </div>
      <div className="mt-auto flex flex-col gap-2">
        <Popover open={helpOpen} onOpenChange={setHelpOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label={t('common:navigation.help')}
                  className={cn(
                    railButton,
                    helpOpen &&
                      'bg-sidebar-foreground/15 text-sidebar-foreground'
                  )}
                >
                  <CircleHelp size={20} strokeWidth={1.7} />
                </button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={12}>
              {t('common:navigation.help')}
            </TooltipContent>
          </Tooltip>
          <PopoverContent
            // Closing the menu would hand focus back to the Help button, and
            // out of the support chat it just opened.
            onCloseAutoFocus={(event) => {
              if (useSupportChatStore.getState().sheetOpen)
                event.preventDefault()
            }}
            side="right"
            align="end"
            sideOffset={12}
            className="w-60 rounded-xl p-1.5"
          >
            <div className="px-2.5 py-2 text-xs font-medium text-muted-foreground">
              {t('common:navigation.helpTitle')}
            </div>
            <button
              type="button"
              className={helpItem}
              data-testid="help-chat-with-us"
              onClick={openSupportChat}
            >
              <MessageCircle size={17} />
              <span>{t('common:navigation.chatWithUs')}</span>
            </button>
            <button
              type="button"
              className={helpItem}
              onClick={() => void openExternal(SUPPORT_EMAIL)}
            >
              <Mail size={17} />
              <span>{t('common:navigation.emailSupport')}</span>
            </button>
            <button
              type="button"
              className={helpItem}
              onClick={() => void openExternal(DISCORD_URL)}
            >
              <IconBrandDiscord size={17} />
              <span>{t('common:navigation.discord')}</span>
            </button>
            <button
              type="button"
              className={helpItem}
              onClick={() => void openExternal(NEW_ISSUE_URL)}
            >
              <Github size={17} />
              <span>{t('common:navigation.newGithubIssue')}</span>
            </button>
          </PopoverContent>
        </Popover>
        {item(
          'settings',
          t('common:settings'),
          route.settings.general,
          <Settings size={20} strokeWidth={1.7} />
        )}
      </div>
      {/* Portalled to the body; mounted here with the menu that opens it. */}
      <SupportChatSheet />
    </nav>
  )
}
