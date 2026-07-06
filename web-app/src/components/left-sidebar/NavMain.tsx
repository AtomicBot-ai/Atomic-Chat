import { LucideIcon } from 'lucide-react'
import { route } from '@/constants/routes'

import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { useTranslation } from '@/i18n/react-i18next-compat'

import { Link, useNavigate, useLocation } from '@tanstack/react-router'
import { PlatformMetaKey } from '@/containers/PlatformMetaKey'
import React, { useRef } from 'react'
import {
  SearchIcon,
  type SearchIconHandle,
} from '@/components/animated-icon/search'
import {
  FolderPlusIcon,
  type FolderPlusIconHandle,
} from '@/components/animated-icon/folder-plus'
import {
  MessageCircleIcon,
  type MessageCircleIconHandle,
} from '@/components/animated-icon/message-circle'
import {
  SettingsIcon,
  type SettingsIconHandle,
} from '@/components/animated-icon/settings'
import { BlocksIcon, type BlocksIconHandle } from '../animated-icon/blocks'
import { BotIcon, type BotIconHandle } from '@/components/animated-icon/bot'
import { PlugIcon, type PlugIconHandle } from '@/components/animated-icon/plug'
import AddProjectDialog from '@/containers/dialogs/AddProjectDialog'
import { SearchDialog } from '@/containers/dialogs/SearchDialog'
import { useThreadManagement } from '@/hooks/useThreadManagement'
import { useSearchDialog } from '@/hooks/useSearchDialog'
import { useProjectDialog } from '@/hooks/useProjectDialog'
import { useAgentMode } from '@/hooks/useAgentMode'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { PlatformShortcuts, ShortcutAction } from '@/lib/shortcuts'

type AnimatedIconHandle =
  | SearchIconHandle
  | FolderPlusIconHandle
  | MessageCircleIconHandle
  | SettingsIconHandle
  | BlocksIconHandle
  | BotIconHandle
  | PlugIconHandle

type NavMainItem = {
  title: string
  url?: string
  icon?: LucideIcon | React.ComponentType<{ className?: string }>
  animatedIcon?: React.ForwardRefExoticComponent<
    {
      className?: string
      size?: number
    } & React.RefAttributes<AnimatedIconHandle>
  >
  isActive?: boolean
  shortcut?: React.ReactNode
  badge?: React.ReactNode
  onClick?: () => void
}

// Small "New" pill to flag a recently added nav destination.
function NewBadge() {
  const { t } = useTranslation()
  return (
    <span className="ml-auto shrink-0 rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-600 dark:bg-blue-400/15 dark:text-blue-400">
      {t('common:newBadge')}
    </span>
  )
}

// Highlight a nav entry while its page is open. Only items with a `url`
// (Models, Integrations, Settings) are persistent destinations; action items
// (new chat, new project, search) have no `url` and never highlight. Matches on
// the section root so Settings stays active across its sub-pages.
const isNavItemActive = (pathname: string, url?: string): boolean => {
  if (!url) return false
  const root = '/' + (url.split('/').filter(Boolean)[0] ?? '')
  return pathname === root || pathname.startsWith(root + '/')
}

const getNavMainItems = (
  onNewProject: () => void,
  onSearch: () => void,
  onNewChat: () => void,
  onJanClaw: () => void
): NavMainItem[] => [
  {
    title: 'common:newChat',
    animatedIcon: MessageCircleIcon,
    onClick: onNewChat,
    shortcut: (
      <KbdGroup className="ml-auto scale-90 gap-0">
        <Kbd className="bg-transparent size-3">
          <PlatformMetaKey />
        </Kbd>
        <Kbd className="bg-transparent size-3 uppercase">
          {PlatformShortcuts[ShortcutAction.NEW_CHAT].key}
        </Kbd>
      </KbdGroup>
    ),
  },
  {
    title: 'common:newAgentChat',
    animatedIcon: BotIcon,
    onClick: onJanClaw,
    shortcut: (
      <KbdGroup className="ml-auto scale-90 gap-0">
        <Kbd className="bg-transparent size-3">
          <PlatformMetaKey />
        </Kbd>
        <Kbd className="bg-transparent size-3 uppercase">
          {PlatformShortcuts[ShortcutAction.NEW_AGENT_CHAT].key}
        </Kbd>
      </KbdGroup>
    ),
  },
  {
    title: 'common:projects.new',
    animatedIcon: FolderPlusIcon,
    onClick: onNewProject,
    shortcut: (
      <KbdGroup className="ml-auto scale-90 gap-0">
        <Kbd className="bg-transparent size-3">
          <PlatformMetaKey />
        </Kbd>
        <Kbd className="bg-transparent size-3 uppercase">
          {PlatformShortcuts[ShortcutAction.NEW_PROJECT].key}
        </Kbd>
      </KbdGroup>
    ),
  },
  {
    title: 'common:models',
    url: route.hub.index,
    animatedIcon: BlocksIcon,
  },
  {
    title: 'common:launch',
    url: route.launch.index,
    animatedIcon: PlugIcon,
    badge: <NewBadge />,
  },
  {
    title: 'common:settings',
    url: route.settings.general,
    animatedIcon: SettingsIcon,
  },
  {
    title: 'common:search',
    animatedIcon: SearchIcon,
    onClick: onSearch,
    shortcut: (
      <KbdGroup className="ml-auto scale-90 gap-0">
        <Kbd className="bg-transparent size-3">
          <PlatformMetaKey />
        </Kbd>
        <Kbd className="bg-transparent size-3 uppercase">
          {PlatformShortcuts[ShortcutAction.SEARCH].key}{' '}
        </Kbd>
      </KbdGroup>
    ),
  },
]

function NavMainItemWithAnimatedIcon({
  item,
  label,
}: {
  item: NavMainItem
  label: string
}) {
  const iconRef = useRef<AnimatedIconHandle>(null)
  const AnimatedIcon = item.animatedIcon!

  const content = (
    <>
      <AnimatedIcon ref={iconRef} className="text-foreground/70" size={16} />
      <span>{label}</span>
      {item.badge}
      {item.shortcut}
    </>
  )

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild={!!item.url}
        isActive={item.isActive}
        className="data-[active=true]:bg-sidebar-foreground/15"
        onMouseEnter={() => iconRef.current?.startAnimation()}
        onMouseLeave={() => iconRef.current?.stopAnimation()}
        onClick={item.onClick}
      >
        {item.url ? <Link to={item.url}>{content}</Link> : content}
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

export function NavMain() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { addFolder } = useThreadManagement()
  const { open: searchOpen, setOpen: setSearchOpen } = useSearchDialog()
  const { open: projectDialogOpen, setOpen: setProjectDialogOpen } =
    useProjectDialog()
  const integrationsBadgeSeen = useGeneralSetting((s) => s.integrationsBadgeSeen)
  const navMainItems = getNavMainItems(
    () => setProjectDialogOpen(true),
    () => setSearchOpen(true),
    () => {
      useAgentMode.getState().removeThread(TEMPORARY_CHAT_ID)
      navigate({ to: route.home })
    },
    () => {
      useAgentMode.getState().setAgentMode(TEMPORARY_CHAT_ID, true)
      navigate({ to: route.home })
    }
  )
    .filter((item) => item.title !== 'common:newAgentChat')
    // Hide the Integrations "New" pill once the user has opened it.
    .map((item) =>
      item.title === 'common:launch' && integrationsBadgeSeen
        ? { ...item, badge: undefined }
        : item
    )
    .map((item) => ({ ...item, isActive: isNavItemActive(pathname, item.url) }))

  const handleCreateProject = async (name: string, assistantId?: string) => {
    const newProject = await addFolder(name, assistantId)
    setProjectDialogOpen(false)
    navigate({
      to: '/project/$projectId',
      params: { projectId: newProject.id },
    })
  }

  return (
    <>
      <SidebarMenu>
        {navMainItems.map((item) => {
          if (item.animatedIcon) {
            return (
              <NavMainItemWithAnimatedIcon
                key={item.title}
                item={item}
                label={t(item.title)}
              />
            )
          }

          const Icon = item.icon
          return (
            <SidebarMenuItem key={item.title}>
              <SidebarMenuButton
                asChild={!!item.url}
                isActive={item.isActive}
                className="data-[active=true]:bg-sidebar-foreground/15"
                onClick={item.onClick}
              >
                {item.url ? (
                  <Link to={item.url}>
                    {Icon && <Icon className="text-foreground/70" />}
                    <span>{t(item.title)}</span>
                    {item.badge}
                    {item.shortcut}
                  </Link>
                ) : (
                  <>
                    {Icon && <Icon className="text-foreground/70" />}
                    <span>{t(item.title)}</span>
                    {item.badge}
                    {item.shortcut}
                  </>
                )}
              </SidebarMenuButton>
            </SidebarMenuItem>
          )
        })}
      </SidebarMenu>

      <AddProjectDialog
        open={projectDialogOpen}
        onOpenChange={setProjectDialogOpen}
        editingKey={null}
        onSave={handleCreateProject}
      />

      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
    </>
  )
}
