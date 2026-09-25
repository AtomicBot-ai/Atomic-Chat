import { useEffect, useRef } from 'react'
import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  collapsiblePanelAnimation,
} from '@/components/ui/collapsible'
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from '@/components/ui/sidebar'
import { BlocksIcon } from '@/components/animated-icon/blocks'
import {
  ClapperboardIcon,
  type ClapperboardIconHandle,
} from '@/components/animated-icon/clapperboard'
import {
  CloudIcon,
  type CloudIconHandle,
} from '@/components/animated-icon/cloud'
import { FolderPlusIcon } from '@/components/animated-icon/folder-plus'
import {
  ImageIcon,
  type ImageIconHandle,
} from '@/components/animated-icon/image'
import { MessageCircleIcon } from '@/components/animated-icon/message-circle'
import { PlugIcon, type PlugIconHandle } from '@/components/animated-icon/plug'
import {
  PuzzleIcon,
  type PuzzleIconHandle,
} from '@/components/animated-icon/puzzle'
import {
  RadioTowerIcon,
  type RadioTowerIconHandle,
} from '@/components/animated-icon/radio-tower'
import AddProjectDialog from '@/containers/dialogs/AddProjectDialog'
import { SearchDialog } from '@/containers/dialogs/SearchDialog'
import { WORKFLOW_ICONS } from '@/containers/images/workflowIcons'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useLeftPanel } from '@/hooks/useLeftPanel'
import { useProjectDialog } from '@/hooks/useProjectDialog'
import { useSearchDialog } from '@/hooks/useSearchDialog'
import { useThreadManagement } from '@/hooks/useThreadManagement'
import { IMAGE_WORKFLOWS } from '@/lib/diffusion/workflows'
import { PlatformFeatures } from '@/lib/platform/const'
import { PlatformFeature } from '@/lib/platform/types'
import { cn } from '@/lib/utils'

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
  const pluginsIconRef = useRef<PuzzleIconHandle>(null)
  const cloudIconRef = useRef<CloudIconHandle>(null)
  const projectIconRef = useRef<AnimatedIconHandle>(null)
  const integrationsIconRef = useRef<PlugIconHandle>(null)
  const apiIconRef = useRef<RadioTowerIconHandle>(null)
  const imagesIconRef = useRef<ImageIconHandle>(null)
  const videosIconRef = useRef<ClapperboardIconHandle>(null)
  const integrationsBadgeSeen = useGeneralSetting(
    (state) => state.integrationsBadgeSeen
  )
  const connectorsBadgeSeen = useGeneralSetting(
    (state) => state.connectorsBadgeSeen
  )
  const pluginsExpanded = useLeftPanel((state) => state.pluginsExpanded)
  const setPluginsExpanded = useLeftPanel((state) => state.setPluginsExpanded)
  const imagesExpanded = useLeftPanel((state) => state.imagesExpanded)
  const setImagesExpanded = useLeftPanel((state) => state.setImagesExpanded)
  const { addFolder } = useThreadManagement()
  const projectDialogOpen = useProjectDialog((state) => state.open)
  const setProjectDialogOpen = useProjectDialog((state) => state.setOpen)
  const { open: searchOpen, setOpen: setSearchOpen } = useSearchDialog()

  const isPluginsRoute =
    pathname.startsWith('/connectors') || pathname.startsWith('/skills')

  // Landing on a plugin page from somewhere else (deep link, search) should
  // reveal where that page lives rather than leaving the group shut.
  useEffect(() => {
    if (isPluginsRoute) setPluginsExpanded(true)
  }, [isPluginsRoute, setPluginsExpanded])

  // On the Images page the workflow list is the page's own navigation, so it
  // stays open; elsewhere the chevron decides.
  const isImagesRoute = pathname.startsWith('/images')
  useEffect(() => {
    if (isImagesRoute) setImagesExpanded(true)
  }, [isImagesRoute, setImagesExpanded])

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
              <span>{t('common:modelHub')}</span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
        {/* Local image generation. Desktop only: it needs the native plugin
            that supervises sd-server, so the row is gated the same way voice
            input is rather than shown and then refused. */}
        {PlatformFeatures[PlatformFeature.MEDIA_GENERATION] && (
          <Collapsible
            open={imagesExpanded}
            onOpenChange={setImagesExpanded}
            className="group/images"
          >
            <SidebarMenuItem>
              {/* Images is a section, like Plugins: the entire row toggles its
                  children. A tiny chevron-only target made the row look
                  clickable while most of it navigated somewhere else. */}
              <CollapsibleTrigger asChild>
                <SidebarMenuButton
                  isActive={isImagesRoute && !imagesExpanded}
                  className="data-[active=true]:bg-sidebar-foreground/15"
                  onMouseEnter={() => imagesIconRef.current?.startAnimation()}
                  onMouseLeave={() => imagesIconRef.current?.stopAnimation()}
                  data-testid="images-disclosure"
                >
                  <ImageIcon
                    ref={imagesIconRef}
                    className="text-foreground/70"
                    size={16}
                  />
                  <span>{t('common:images')}</span>
                  <ChevronRight
                    className={cn(
                      'text-muted-foreground ml-auto size-4 shrink-0 transition-transform duration-200 ease-out',
                      imagesExpanded && 'rotate-90'
                    )}
                  />
                </SidebarMenuButton>
              </CollapsibleTrigger>
              <CollapsibleContent className={collapsiblePanelAnimation}>
                <SidebarMenuSub data-testid="images-submenu">
                  {IMAGE_WORKFLOWS.map((workflow) => {
                    const Icon = WORKFLOW_ICONS[workflow.id]
                    const active =
                      workflow.id === 'create'
                        ? pathname === '/images' || pathname === '/images/'
                        : pathname.startsWith(workflow.path)
                    return (
                      <SidebarMenuSubItem key={workflow.id}>
                        <SidebarMenuSubButton
                          asChild
                          isActive={active}
                          className="data-[active=true]:bg-sidebar-foreground/15"
                        >
                          <Link to={workflow.path}>
                            <Icon
                              size={14}
                              className="shrink-0 text-foreground/70"
                            />
                            <span>
                              {t(`images:workflow.${workflow.id}.label`)}
                            </span>
                          </Link>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    )
                  })}
                </SidebarMenuSub>
              </CollapsibleContent>
            </SidebarMenuItem>
          </Collapsible>
        )}
        {/* Local video generation shares the engine with Images and sits
            right under it: one row, no workflows to unfold. */}
        {PlatformFeatures[PlatformFeature.MEDIA_GENERATION] && (
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={pathname.startsWith('/videos')}
              className="data-[active=true]:bg-sidebar-foreground/15"
              onMouseEnter={() => videosIconRef.current?.startAnimation()}
              onMouseLeave={() => videosIconRef.current?.stopAnimation()}
            >
              <Link to={route.videos.index} data-testid="videos-link">
                <ClapperboardIcon
                  ref={videosIconRef}
                  className="text-foreground/70"
                  size={16}
                />
                <span>{t('common:video')}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        )}
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
        {/* Connectors and skills are both things you plug into the model, so
            they share one group instead of two top-level rows. Both serve chat
            and agent runs alike. The sub-rows stay icon-free — the group icon
            already carries the section, and a column of icons under an indent
            reads as noise. */}
        <Collapsible
          open={pluginsExpanded}
          onOpenChange={setPluginsExpanded}
          className="group/plugins"
        >
          <SidebarMenuItem>
            <CollapsibleTrigger asChild>
              <SidebarMenuButton
                isActive={isPluginsRoute && !pluginsExpanded}
                className="data-[active=true]:bg-sidebar-foreground/15"
                onMouseEnter={() => pluginsIconRef.current?.startAnimation()}
                onMouseLeave={() => pluginsIconRef.current?.stopAnimation()}
              >
                <PuzzleIcon
                  ref={pluginsIconRef}
                  className="text-foreground/70"
                  size={16}
                />
                <span>{t('common:plugins')}</span>
                {/* Collapsed, the group is the only place the connectors
                    badge can show — otherwise it hides behind a shut row. */}
                {!connectorsBadgeSeen && !pluginsExpanded && (
                  <span className="shrink-0 rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-600 dark:bg-blue-400/15 dark:text-blue-400">
                    {t('common:newBadge')}
                  </span>
                )}
                <ChevronRight
                  className={cn(
                    'text-muted-foreground ml-auto size-4 shrink-0 transition-transform duration-200 ease-out',
                    pluginsExpanded && 'rotate-90'
                  )}
                />
              </SidebarMenuButton>
            </CollapsibleTrigger>
            <CollapsibleContent className={collapsiblePanelAnimation}>
              <SidebarMenuSub>
                <SidebarMenuSubItem>
                  <SidebarMenuSubButton
                    asChild
                    isActive={pathname.startsWith('/connectors')}
                    className="data-[active=true]:bg-sidebar-foreground/15"
                  >
                    <Link to={route.connectors.index}>
                      <span>{t('common:connectors')}</span>
                      {!connectorsBadgeSeen && (
                        <span className="ml-auto shrink-0 rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-600 dark:bg-blue-400/15 dark:text-blue-400">
                          {t('common:newBadge')}
                        </span>
                      )}
                    </Link>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
                <SidebarMenuSubItem>
                  <SidebarMenuSubButton
                    asChild
                    isActive={pathname.startsWith('/skills')}
                    className="data-[active=true]:bg-sidebar-foreground/15"
                  >
                    <Link to={route.skills.index}>
                      <span>{t('common:skills')}</span>
                    </Link>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              </SidebarMenuSub>
            </CollapsibleContent>
          </SidebarMenuItem>
        </Collapsible>
        <>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={pathname.startsWith('/launch')}
              className="data-[active=true]:bg-sidebar-foreground/15"
              onMouseEnter={() => integrationsIconRef.current?.startAnimation()}
              onMouseLeave={() => integrationsIconRef.current?.stopAnimation()}
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
