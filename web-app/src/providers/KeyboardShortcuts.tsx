import { useKeyboardShortcut } from '@/hooks/useHotkeys'
import { useSidebar } from '@/components/ui/sidebar'
import { useSearchDialog } from '@/hooks/useSearchDialog'
import { useProjectDialog } from '@/hooks/useProjectDialog'
import { useRouter } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { PlatformShortcuts, ShortcutAction } from '@/lib/shortcuts'

export function KeyboardShortcutsProvider() {
  // Through the sidebar, so in a window too narrow to dock it the shortcut
  // opens and closes the overlay without touching the saved preference.
  const { toggleSidebar } = useSidebar()
  const { setOpen: setSearchOpen } = useSearchDialog()
  const { setOpen: setProjectDialogOpen } = useProjectDialog()
  const router = useRouter()

  // Get shortcut specs from centralized configuration
  const sidebarShortcut = PlatformShortcuts[ShortcutAction.TOGGLE_SIDEBAR]
  const newChatShortcut = PlatformShortcuts[ShortcutAction.NEW_CHAT]
  const newProjectShortcut = PlatformShortcuts[ShortcutAction.NEW_PROJECT]
  const settingsShortcut = PlatformShortcuts[ShortcutAction.GO_TO_SETTINGS]
  const searchShortcut = PlatformShortcuts[ShortcutAction.SEARCH]

  // Toggle Sidebar
  useKeyboardShortcut({
    ...sidebarShortcut,
    callback: toggleSidebar,
  })

  // New Chat
  useKeyboardShortcut({
    ...newChatShortcut,
    callback: () => {
      router.navigate({ to: route.home })
    },
  })

  // New Project
  useKeyboardShortcut({
    ...newProjectShortcut,
    callback: () => {
      setProjectDialogOpen(true)
    },
  })

  // Go to Settings
  useKeyboardShortcut({
    ...settingsShortcut,
    callback: () => {
      router.navigate({ to: route.settings.general })
    },
  })

  // Search
  useKeyboardShortcut({
    ...searchShortcut,
    callback: () => {
      setSearchOpen(true)
    },
  })

  // This component doesn't render anything
  return null
}
