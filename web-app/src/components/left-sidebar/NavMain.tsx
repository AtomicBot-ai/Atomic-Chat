import { useRef } from 'react'
import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { BlocksIcon } from '@/components/animated-icon/blocks'
import {
  CloudIcon,
  type CloudIconHandle,
} from '@/components/animated-icon/cloud'
import { FileTextIcon } from '@/components/animated-icon/file-text'
import { FolderPlusIcon } from '@/components/animated-icon/folder-plus'
import { MessageCircleIcon } from '@/components/animated-icon/message-circle'
import { PlugIcon, type PlugIconHandle } from '@/components/animated-icon/plug'
import {
  RadioTowerIcon,
  type RadioTowerIconHandle,
} from '@/components/animated-icon/radio-tower'
import {
  UnplugIcon,
  type UnplugIconHandle,
} from '@/components/animated-icon/unplug'
import AddProjectDialog from '@/containers/dialogs/AddProjectDialog'
import { SearchDialog } from '@/containers/dialogs/SearchDialog'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useProjectDialog } from '@/hooks/useProjectDialog'
import { useSearchDialog } from '@/hooks/useSearchDialog'
import { useThreadManagement } from '@/hooks/useThreadManagement'

type AnimatedIconHandle = {
  startAnimation: () => void
  stopAnimation: () => void
}

export function NavMain() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const newChatIconRef = useRef<AnimatedIconHandle>(null)
  const modelsIconRef = useRef<AnimatedIconHandle>(null)
  const skillsIconRef = useRef<AnimatedIconHandle>(null)
  const cloudIconRef = useRef<CloudIconHandle>(null)
  const projectIconRef = useRef<AnimatedIconHandle>(null)
  const integrationsIconRef = useRef<PlugIconHandle>(null)
  const connectorsIconRef = useRef<UnplugIconHandle>(null)
  const apiIconRef = useRef<RadioTowerIconHandle>(null)
  const integrationsBadgeSeen = useGeneralSetting(
    (state) => state.integrationsBadgeSeen
  )
  const connectorsBadgeSeen = useGeneralSetting(
    (state) => state.connectorsBadgeSeen
  )
  const { addFolder } = useThreadManagement()
  const projectDialogOpen = useProjectDialog((state) => state.open)
  const setProjectDialogOpen = useProjectDialog((state) => state.setOpen)
  const { open: searchOpen, setOpen: setSearchOpen } = useSearchDialog()

  const handleNewChat = () => {
    navigate({ to: route.home })
  }

  const handleCreateProject = async (name: string, assistantId?: string) => {
    const project = await addFolder(name, assistantId)
    setProjectDialogOpen(false)
    navigate({
      to: '/project/$projectId',
      params: { projectId: project.id },
    })
  }

  return (
    <>
      <SidebarMenu className="mt-3 px-2">
        <SidebarMenuItem>
          <SidebarMenuButton
            className="font-medium"
            onClick={handleNewChat}
            onMouseEnter={() => newChatIconRef.current?.startAnimation()}
            onMouseLeave={() => newChatIconRef.current?.stopAnimation()}
          >
            <MessageCircleIcon
              ref={newChatIconRef}
              className="text-foreground/70"
              size={16}
            />
            <span>{t('common:newChat')}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton
            asChild
            isActive={pathname.startsWith('/hub')}
            className="data-[active=true]:bg-sidebar-foreground/15"
            onMouseEnter={() => modelsIconRef.current?.startAnimation()}
            onMouseLeave={() => modelsIconRef.current?.stopAnimation()}
          >
            <Link to={route.hub.index}>
              <BlocksIcon
                ref={modelsIconRef}
                className="text-foreground/70"
                size={16}
              />
              <span>{t('common:models')}</span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
        {/* Cloud is offered in both modes: agent mode is what a user with no
            local engine is most likely to be blocked on, and connecting a
            provider is the fix. */}
        <SidebarMenuItem>
          <SidebarMenuButton
            asChild
            isActive={pathname.startsWith('/cloud')}
            className="data-[active=true]:bg-sidebar-foreground/15"
            onMouseEnter={() => cloudIconRef.current?.startAnimation()}
            onMouseLeave={() => cloudIconRef.current?.stopAnimation()}
          >
            <Link to={route.cloud.index}>
              <CloudIcon
                ref={cloudIconRef}
                className="text-foreground/70"
                size={16}
              />
              <span>{t('common:cloud')}</span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
        {/* MCP connectors serve both modes: chat tool calls and agent runs
            use the same server registry. */}
        <SidebarMenuItem>
          <SidebarMenuButton
            asChild
            isActive={pathname.startsWith('/connectors')}
            className="data-[active=true]:bg-sidebar-foreground/15"
            onMouseEnter={() => connectorsIconRef.current?.startAnimation()}
            onMouseLeave={() => connectorsIconRef.current?.stopAnimation()}
          >
            <Link to={route.connectors.index}>
              <UnplugIcon
                ref={connectorsIconRef}
                className="text-foreground/70"
                size={16}
              />
              <span>{t('common:connectors')}</span>
              {!connectorsBadgeSeen && (
                <span className="ml-auto shrink-0 rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-600 dark:bg-blue-400/15 dark:text-blue-400">
                  {t('common:newBadge')}
                </span>
              )}
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton
            asChild
            isActive={pathname.startsWith('/skills')}
            className="data-[active=true]:bg-sidebar-foreground/15"
            onMouseEnter={() => skillsIconRef.current?.startAnimation()}
            onMouseLeave={() => skillsIconRef.current?.stopAnimation()}
          >
            <Link to={route.skills.index}>
              <FileTextIcon
                ref={skillsIconRef}
                className="text-foreground/70"
                size={16}
              />
              <span>{t('common:skills')}</span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => setProjectDialogOpen(true)}
                onMouseEnter={() => projectIconRef.current?.startAnimation()}
                onMouseLeave={() => projectIconRef.current?.stopAnimation()}
              >
                <FolderPlusIcon
                  ref={projectIconRef}
                  className="text-foreground/70"
                  size={16}
                />
                <span>{t('common:projects.new')}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                isActive={pathname.startsWith('/launch')}
                className="data-[active=true]:bg-sidebar-foreground/15"
                onMouseEnter={() =>
                  integrationsIconRef.current?.startAnimation()
                }
                onMouseLeave={() =>
                  integrationsIconRef.current?.stopAnimation()
                }
              >
                <Link to={route.launch.index}>
                  <PlugIcon
                    ref={integrationsIconRef}
                    className="text-foreground/70"
                    size={16}
                  />
                  <span>{t('common:launch')}</span>
                  {!integrationsBadgeSeen && (
                    <span className="ml-auto shrink-0 rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-600 dark:bg-blue-400/15 dark:text-blue-400">
                      {t('common:newBadge')}
                    </span>
                  )}
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                isActive={pathname.startsWith('/api')}
                className="data-[active=true]:bg-sidebar-foreground/15"
                onMouseEnter={() => apiIconRef.current?.startAnimation()}
                onMouseLeave={() => apiIconRef.current?.stopAnimation()}
              >
                <Link to={route.api.index}>
                  <RadioTowerIcon
                    ref={apiIconRef}
                    className="text-foreground/70"
                    size={16}
                  />
                  <span>{t('common:api')}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
        </>
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
