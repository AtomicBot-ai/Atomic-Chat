import { useLocation, useNavigate } from '@tanstack/react-router'
import {
  Blocks,
  Clapperboard,
  Cloud,
  Download,
  Image,
  MessageCircle,
  Network,
  Plug,
  RadioTower,
  Search,
  Settings2,
  Shield,
  Wifi,
} from 'lucide-react'
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { PlatformFeatures } from '@/lib/platform/const'
import { PlatformFeature } from '@/lib/platform/types'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useProjectDialog } from '@/hooks/useProjectDialog'
import { useSearchDialog } from '@/hooks/useSearchDialog'
import { useThreadManagement } from '@/hooks/useThreadManagement'
import AddProjectDialog from '@/containers/dialogs/AddProjectDialog'
import { SearchDialog } from '@/containers/dialogs/SearchDialog'
import { ServerControlPanel } from '@/containers/ServerControlPanel'
import { EngineNavigation, SettingsNavigation } from '@/containers/SettingsMenu'
import { NavChats } from './NavChats'
import { NavPinned } from './NavPinned'
import { NavProjects } from './NavProjects'
import { NavServerAgents } from './NavServerAgents'
import { NavGroupLabel, NavRow, NewBadge } from './NavRow'
import { NavigationRail } from './NavigationRail'
import { isPathActive, navigationSection } from '@/lib/navigation'
import { WindowTitlebar } from './WindowTitlebar'

function WorkspaceNavigation({
  onCreateProject,
}: {
  onCreateProject: () => void
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const media = PlatformFeatures[PlatformFeature.MEDIA_GENERATION]

  return (
    <>
      <SidebarMenu className="px-2">
        <SidebarMenuItem>
          <SidebarMenuButton
            className="font-medium"
            onClick={() => navigate({ to: route.home })}
          >
            <MessageCircle size={16} />
            <span>{t('common:newChat')}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        {/* Local image and video generation need the native plugin that
            supervises sd-server, so the rows are gated rather than shown and
            then refused. */}
        {media && (
          <NavRow
            to={route.images.index}
            label={t('common:images')}
            icon={<Image size={16} />}
            active={isPathActive(pathname, route.images.index, true)}
            testId="images-link"
          />
        )}
        {media && (
          <NavRow
            to={route.videos.index}
            label={t('common:video')}
            icon={<Clapperboard size={16} />}
            active={isPathActive(pathname, route.videos.index, true)}
            testId="videos-link"
          />
        )}
      </SidebarMenu>
      <NavPinned />
      <NavProjects onCreate={onCreateProject} />
      <NavChats />
    </>
  )
}

function ServerNavigation() {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const integrationsBadgeSeen = useGeneralSetting(
    (state) => state.integrationsBadgeSeen
  )

  return (
    <>
      {PlatformFeatures[PlatformFeature.LOCAL_API_SERVER] && (
        <ServerControlPanel />
      )}
      <SidebarMenu className="px-2">
        <NavRow
          to={route.api.index}
          label={t('common:navigation.overview')}
          icon={<RadioTower size={16} />}
          active={isPathActive(pathname, route.api.index)}
        />
        <NavRow
          to={route.launch.index}
          label={t('common:launch')}
          icon={<Plug size={16} />}
          active={isPathActive(pathname, route.launch.index)}
          trailing={!integrationsBadgeSeen && <NewBadge />}
        />
        {PlatformFeatures[PlatformFeature.LOCAL_API_SERVER] && (
          <>
            <NavRow
              to={route.settings.local_api_server}
              label={t('common:navigation.configuration')}
              icon={<Settings2 size={16} />}
              active={isPathActive(pathname, route.settings.local_api_server)}
            />
            <NavRow
              to={route.settings.remote_lan}
              label={t('common:navigation.remoteAccess')}
              icon={<Wifi size={16} />}
              active={isPathActive(pathname, route.settings.remote_lan)}
            />
          </>
        )}
        {PlatformFeatures[PlatformFeature.HTTPS_PROXY] && (
          <NavRow
            to={route.settings.https_proxy}
            label={t('common:https_proxy')}
            icon={<Shield size={16} />}
            active={isPathActive(pathname, route.settings.https_proxy)}
          />
        )}
      </SidebarMenu>
      <NavServerAgents />
    </>
  )
}

function ModelsNavigation() {
  const { t } = useTranslation()
  const { pathname, search } = useLocation()
  const params = search as Record<string, unknown>
  const onHub = isPathActive(pathname, route.hub.index)
  const onCloud = isPathActive(pathname, route.cloud.index)
  // Downloads and Custom Endpoint are views of the Hub and Cloud pages, kept
  // in the URL so the row that opened them stays highlighted.
  const installedOnly = onHub && params.installed === true
  const addingCustom = onCloud && params.add === 'custom'

  return (
    <>
      <SidebarMenu className="px-2">
        <NavRow
          to={route.hub.index}
          search={{ installed: true }}
          label={t('common:downloads')}
          icon={<Download size={16} />}
          active={installedOnly}
        />
      </SidebarMenu>
      <NavGroupLabel>{t('common:navigation.discover')}</NavGroupLabel>
      <SidebarMenu className="px-2">
        <NavRow
          to={route.hub.index}
          label={t('common:navigation.localModels')}
          icon={<Blocks size={16} />}
          active={onHub && !installedOnly}
        />
        <NavRow
          to={route.cloud.index}
          label={t('common:navigation.cloudProviders')}
          icon={<Cloud size={16} />}
          active={onCloud && !addingCustom}
        />
        <NavRow
          to={route.cloud.index}
          search={{ add: 'custom' }}
          label={t('common:navigation.customEndpoint')}
          icon={<Network size={16} />}
          active={addingCustom}
        />
      </SidebarMenu>
      <EngineNavigation />
    </>
  )
}

const SECTION_TITLES = {
  chat: 'common:navigation.workspace',
  server: 'common:navigation.server',
  models: 'common:navigation.modelsHub',
  settings: 'common:settings',
} as const

/**
 * The navigation shell: the icon rail picks a section, the floating sidebar
 * shows that section's navigation, and the title bar row above both holds the
 * sidebar toggle.
 */
export function LeftSidebar() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const section = navigationSection(pathname)
  const { addFolder } = useThreadManagement()
  const projectDialogOpen = useProjectDialog((state) => state.open)
  const setProjectDialogOpen = useProjectDialog((state) => state.setOpen)
  const { open: searchOpen, setOpen: setSearchOpen } = useSearchDialog()

  const handleCreateProject = async (name: string, assistantId?: string) => {
    const project = await addFolder(name, assistantId)
    setProjectDialogOpen(false)
    navigate({
      to: '/project/$projectId',
      params: { projectId: project.id },
    })
    return project.id
  }

  return (
    <>
      <NavigationRail section={section} />
      <WindowTitlebar section={section} />
      <div className="relative z-30">
        <Sidebar variant="floating" collapsible="offcanvas">
          <SidebarHeader className="gap-0 px-3 pb-2 pt-3">
            <div className="flex items-center justify-between px-1 pb-1">
              <h2 className="font-studio truncate text-lg font-semibold">
                {t(SECTION_TITLES[section])}
              </h2>
              {section === 'chat' && (
                <button
                  type="button"
                  aria-label={t('common:navigation.searchChats')}
                  title={t('common:navigation.searchChats')}
                  onClick={() => setSearchOpen(true)}
                  className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-foreground/8"
                >
                  <Search size={16} />
                </button>
              )}
            </div>
          </SidebarHeader>
          <SidebarContent
            className="mask-b-from-95%"
            aria-label={t(SECTION_TITLES[section])}
          >
            {section === 'chat' && (
              <WorkspaceNavigation
                onCreateProject={() => setProjectDialogOpen(true)}
              />
            )}
            {section === 'server' && <ServerNavigation />}
            {section === 'models' && <ModelsNavigation />}
            {section === 'settings' && <SettingsNavigation />}
          </SidebarContent>
          <SidebarRail />
        </Sidebar>
      </div>
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
