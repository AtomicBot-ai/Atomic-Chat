import { useMemo } from 'react'
import { useParams } from '@tanstack/react-router'
import { ChevronRight, GripVertical } from 'lucide-react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { CSS } from '@dnd-kit/utilities'
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  useSidebar,
} from '@/components/ui/sidebar'
import { ThreadItem } from '@/containers/ThreadList'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  movePinnedThread,
  orderPinnedThreads,
  useSidebarLists,
} from '@/hooks/useSidebarLists'
import { useThreads } from '@/hooks/useThreads'
import { cn } from '@/lib/utils'

function PinnedRow({
  thread,
  isActive,
}: {
  thread: Thread
  isActive: boolean
}) {
  const { t } = useTranslation()
  const { isMobile } = useSidebar()
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: thread.id })
  const title = thread.title || t('common:newThread')

  return (
    <ThreadItem
      thread={thread}
      isActive={isActive}
      isMobile={isMobile}
      rowRef={setNodeRef}
      rowStyle={{
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 10 : undefined,
        opacity: isDragging ? 0.65 : 1,
      }}
      dragHandle={
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={t('common:navigation.moveChat', { title })}
          title={t('common:navigation.dragToReorder')}
          className="absolute left-1 top-1.5 z-10 flex size-5 cursor-grab touch-none items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-sidebar-foreground/8 focus:opacity-100 active:cursor-grabbing group-hover/menu-item:opacity-100 group-focus-within/menu-item:opacity-100 max-md:opacity-100"
        >
          <GripVertical size={13} />
        </button>
      }
    />
  )
}

/** Pinned chats, above Projects and Recents, in an order the user can drag. */
export function NavPinned() {
  const { t } = useTranslation()
  const threads = useThreads((state) => state.threads)
  const pinOrder = useSidebarLists((state) => state.pinOrder)
  const collapsed = useSidebarLists((state) => state.collapsed.pinned)
  const toggleGroup = useSidebarLists((state) => state.toggleGroup)
  const setPinOrder = useSidebarLists((state) => state.setPinOrder)
  const { threadId: activeThreadId } = useParams({ strict: false })

  const pinned = useMemo(
    () => orderPinnedThreads(Object.values(threads), pinOrder),
    [threads, pinOrder]
  )
  const pinnedIds = useMemo(() => pinned.map((thread) => thread.id), [pinned])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  if (pinned.length === 0) return null

  return (
    <SidebarGroup
      aria-label={t('common:navigation.pinned')}
      className="group-data-[collapsible=icon]:hidden"
    >
      <SidebarGroupLabel asChild>
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => toggleGroup('pinned')}
        >
          <ChevronRight
            size={12}
            className={cn(
              'mr-1 transition-transform',
              !collapsed && 'rotate-90'
            )}
          />
          {t('common:navigation.pinned')}
        </button>
      </SidebarGroupLabel>
      {!collapsed && (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          onDragEnd={({ active, over }) => {
            if (!over) return
            setPinOrder(
              movePinnedThread(pinnedIds, String(active.id), String(over.id))
            )
          }}
        >
          <SortableContext
            items={pinnedIds}
            strategy={verticalListSortingStrategy}
          >
            <SidebarMenu>
              {pinned.map((thread) => (
                <PinnedRow
                  key={thread.id}
                  thread={thread}
                  isActive={thread.id === activeThreadId}
                />
              ))}
            </SidebarMenu>
          </SortableContext>
        </DndContext>
      )}
    </SidebarGroup>
  )
}
