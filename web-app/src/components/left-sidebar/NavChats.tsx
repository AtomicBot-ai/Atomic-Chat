import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarGroupAction,
} from '@/components/ui/sidebar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ChevronRight, MoreHorizontal, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useThreads } from '@/hooks/useThreads'
import { useSidebarLists } from '@/hooks/useSidebarLists'
import ThreadList from '@/containers/ThreadList'
import { DeleteAllThreadsDialog } from '@/containers/dialogs/DeleteAllThreadsDialog'
import { route } from '@/constants/routes'
import { cn } from '@/lib/utils'
import {
  filterDeletableSidebarHistoryThreads,
  filterSidebarHistoryThreads,
} from '@/lib/sidebar-thread-mode'

/** "Recents": chats outside any project, minus the pinned ones shown above. */
export function NavChats() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const getFilteredThreads = useThreads((state) => state.getFilteredThreads)
  const threads = useThreads((state) => state.threads)
  const deleteThread = useThreads((state) => state.deleteThread)
  const collapsed = useSidebarLists((state) => state.collapsed.recents)
  const toggleGroup = useSidebarLists((state) => state.toggleGroup)
  const [dropdownOpen, setDropdownOpen] = useState(false)

  const recentThreads = useMemo(() => {
    return filterSidebarHistoryThreads(getFilteredThreads('')).filter(
      (thread) => !thread.isFavorite
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getFilteredThreads, threads])

  const deleteModeThreads = () => {
    filterDeletableSidebarHistoryThreads(recentThreads).forEach((thread) =>
      deleteThread(thread.id)
    )
  }

  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      {/* Nothing to fold until there is a chat in it. */}
      <SidebarGroupLabel asChild>
        {recentThreads.length > 0 ? (
          <button
            type="button"
            aria-expanded={!collapsed}
            onClick={() => toggleGroup('recents')}
          >
            <ChevronRight
              size={12}
              className={cn(
                'mr-1 transition-transform',
                !collapsed && 'rotate-90'
              )}
            />
            {t('common:recents')}
          </button>
        ) : (
          <span>{t('common:recents')}</span>
        )}
      </SidebarGroupLabel>
      <SidebarGroupAction
        className={cn(
          'hover:bg-sidebar-foreground/8',
          recentThreads.length > 0 && 'right-10'
        )}
        aria-label={t('common:newChat')}
        title={t('common:newChat')}
        onClick={() => navigate({ to: route.home })}
      >
        <Plus className="text-muted-foreground" />
      </SidebarGroupAction>
      {recentThreads.length > 0 && (
        <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
          <DropdownMenuTrigger asChild>
            <SidebarGroupAction className="hover:bg-sidebar-foreground/8">
              <MoreHorizontal className="text-muted-foreground" />
              <span className="sr-only">More</span>
            </SidebarGroupAction>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start">
            <DeleteAllThreadsDialog
              onDeleteAll={deleteModeThreads}
              onDropdownClose={() => setDropdownOpen(false)}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {!collapsed && (
        <SidebarMenu>
          <ThreadList threads={recentThreads} />
        </SidebarMenu>
      )}
    </SidebarGroup>
  )
}
