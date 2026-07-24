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
import { MoreHorizontal } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useThreads } from '@/hooks/useThreads'
import ThreadList from '@/containers/ThreadList'
import { DeleteAllThreadsDialog } from '@/containers/dialogs/DeleteAllThreadsDialog'
import { useAgentMode, type SidebarMode } from '@/hooks/useAgentMode'
import { useSearchDialog } from '@/hooks/useSearchDialog'
import {
  filterDeletableSidebarHistoryThreads,
  filterSidebarHistoryThreads,
} from '@/lib/sidebar-thread-mode'
import {
  SearchIcon,
  type SearchIconHandle,
} from '@/components/animated-icon/search'

export function NavChats({ mode }: { mode: SidebarMode }) {
  const { t } = useTranslation()
  const getFilteredThreads = useThreads((state) => state.getFilteredThreads)
  const threads = useThreads((state) => state.threads)
  const deleteThread = useThreads((state) => state.deleteThread)
  const agentThreads = useAgentMode((state) => state.agentThreads)
  const setSearchOpen = useSearchDialog((state) => state.setOpen)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const searchIconRef = useRef<SearchIconHandle>(null)

  const threadsWithoutProject = useMemo(() => {
    return filterSidebarHistoryThreads(
      getFilteredThreads(''),
      mode,
      agentThreads
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentThreads, getFilteredThreads, mode, threads])

  const deleteModeThreads = () => {
    filterDeletableSidebarHistoryThreads(
      threadsWithoutProject,
      mode,
      agentThreads
    ).forEach((thread) => deleteThread(thread.id))
  }

  if (threadsWithoutProject.length === 0) {
    return null
  }

  return (
    <SidebarGroup className="group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel>{t('common:chats')}</SidebarGroupLabel>
      <SidebarGroupAction
        className="right-10 hover:bg-sidebar-foreground/8 [&>svg]:size-3"
        onClick={() => setSearchOpen(true)}
        onMouseEnter={() => searchIconRef.current?.startAnimation()}
        onMouseLeave={() => searchIconRef.current?.stopAnimation()}
        aria-label={t('common:search')}
      >
        <SearchIcon
          ref={searchIconRef}
          className="text-muted-foreground"
          size={14}
        />
      </SidebarGroupAction>
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
            mode={mode}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <SidebarMenu>
        <ThreadList threads={threadsWithoutProject} />
      </SidebarMenu>
    </SidebarGroup>
  )
}
