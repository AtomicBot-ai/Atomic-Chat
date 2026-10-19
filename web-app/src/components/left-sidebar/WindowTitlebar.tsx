import { useNavigate } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { SidebarTrigger, useSidebar } from '@/components/ui/sidebar'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { NavigationSection } from '@/lib/navigation'

/**
 * The full-width row above the navigation rail and the contextual sidebar.
 *
 * On macOS the window uses `titleBarStyle: "Overlay"`, so the native
 * traffic lights are painted into this row (`trafficLightPosition` in
 * `src-tauri/tauri.macos.conf.json` centres them on it) and the row is the
 * window's drag region. Elsewhere the native title bar sits above it and the
 * row only carries the sidebar controls.
 */
export function WindowTitlebar({ section }: { section: NavigationSection }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { open, openMobile, isMobile } = useSidebar()
  const collapsed = isMobile ? !openMobile : !open

  return (
    <div
      className={cn(
        'fixed inset-x-0 top-0 z-40 flex h-(--window-titlebar-height) items-center gap-1.5 border-b border-sidebar-border/60 bg-sidebar pr-3',
        // Clear the native traffic lights (x=20, three 12px buttons).
        IS_MACOS ? 'pl-20' : 'pl-3'
      )}
      // SidebarTrigger and the new-chat control are <button>s, which Tauri's
      // drag handler leaves clickable.
      {...(IS_MACOS ? { 'data-tauri-drag-region': true } : {})}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <SidebarTrigger
            aria-label={t('common:navigation.toggleSidebar')}
            className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-sidebar-foreground/8!"
          />
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {t('common:navigation.toggleSidebar')}
        </TooltipContent>
      </Tooltip>
      {section === 'chat' && collapsed && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t('common:newChat')}
              onClick={() => navigate({ to: route.home })}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-foreground/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Plus size={16} strokeWidth={1.7} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('common:newChat')}</TooltipContent>
        </Tooltip>
      )}
      {IS_WINDOWS && (
        <span className="ml-auto text-[10px] font-medium text-muted-foreground">
          v{VERSION}
        </span>
      )}
    </div>
  )
}
