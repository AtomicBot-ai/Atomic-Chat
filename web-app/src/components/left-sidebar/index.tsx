import { NavChats } from './NavChats'
import { NavMain } from './NavMain'
import { NavProjects } from './NavProjects'
import { cn } from '@/lib/utils'
import { AppLogo } from '@/components/AppLogo'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { route } from '@/constants/routes'
import { Link, useLocation } from '@tanstack/react-router'
import {
  SettingsIcon,
  type SettingsIconHandle,
} from '@/components/animated-icon/settings'
import { useRef } from 'react'

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarTrigger,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar'

export function LeftSidebar() {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const settingsIconRef = useRef<SettingsIconHandle>(null)

  return (
    <div className="relative z-50">
      <Sidebar variant="floating" collapsible="offcanvas">
        {/*
          On macOS the window uses ``titleBarStyle: "Overlay"`` (see
          ``src-tauri/tauri.macos.conf.json``), so the red/yellow/green
          traffic-light controls are painted on top of our chrome at
          ~y=14, x=14-66 of the window. The first header row (download +
          sidebar toggle) is right-aligned, so it sits well clear of the
          left-edge traffic-light cluster and can share the same Y-coord
          with the system buttons. We therefore keep that row at the top
          and instead push only the left-aligned Atomic Chat logo row
          below the traffic-light band, so it doesn't collide.
        */}
        <SidebarHeader className="flex flex-col gap-1 px-1 pb-0">
          {/* SidebarTrigger is a <button> element that Tauri's drag handler
              explicitly excludes, so it remains clickable. */}
          <div
            className={cn(
              'flex w-full items-center',
              IS_WINDOWS ? 'justify-between' : 'justify-end'
            )}
            {...(IS_MACOS ? { 'data-tauri-drag-region': true } : {})}
          >
            {IS_WINDOWS && (
              <span className="pl-2 text-[10px] font-medium text-muted-foreground">
                v{VERSION}
              </span>
            )}
            <div className="flex items-center">
              <SidebarTrigger className="text-muted-foreground rounded-full hover:bg-sidebar-foreground/8! -mt-0.5 relative z-50 ml-0.5" />
            </div>
          </div>
          <div
            className={cn(
              'mt-1 flex w-full items-center justify-start gap-2 pl-2',
              IS_MACOS && 'mt-3'
            )}
          >
            <AppLogo wordmarkClassName="text-sidebar-foreground" />
          </div>
        </SidebarHeader>
        <SidebarContent className="mask-b-from-95% mask-t-from-98%">
          <NavMain />
          <NavProjects />
          <NavChats />
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                isActive={pathname.startsWith('/settings')}
                className="data-[active=true]:bg-sidebar-foreground/15"
                onMouseEnter={() => settingsIconRef.current?.startAnimation()}
                onMouseLeave={() => settingsIconRef.current?.stopAnimation()}
              >
                <Link to={route.settings.general}>
                  <SettingsIcon
                    ref={settingsIconRef}
                    className="text-foreground/70"
                    size={16}
                  />
                  <span>{t('common:settings')}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
    </div>
  )
}
