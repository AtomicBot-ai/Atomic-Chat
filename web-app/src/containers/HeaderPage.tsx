import { useLeftPanel } from '@/hooks/useLeftPanel'
import { cn } from '@/lib/utils'
import { hasCustomWindowChrome } from '@/lib/window-chrome'
import {
  IconLayoutSidebar,
} from '@tabler/icons-react'
import { ReactNode, memo } from 'react'
import { Button } from "@/components/ui/button"

type HeaderPageProps = {
  children?: ReactNode
  // Onboarding has no sidebar to toggle, so it hides the download + toggle cluster.
  hideControls?: boolean
}
const HeaderPage = memo(function HeaderPage({
  children,
  hideControls,
}: HeaderPageProps) {
  const open = useLeftPanel((state) => state.open)
  const setLeftPanel = useLeftPanel((state) => state.setLeftPanel)
  // The Windows main window has no native title bar: WindowFrame paints
  // Minimize, Maximize and Close over this row's right end, so the row keeps
  // that end clear and is what moves the window.
  const customChrome = hasCustomWindowChrome()

  return (
    <div
      className={cn(
        'h-15 flex items-center shrink-0',
        (IS_MACOS && !open) ? 'pl-24' : ' pl-4',
        customChrome && 'pr-40',
        children === undefined && 'border-none'
      )}
      // On macOS the element-based drag region approach is used: this div sits
      // inside the SidebarInset which is in normal document flow, so it is
      // always at its natural z-level and can receive mousedown events.
      // Tauri's drag handler excludes clicks on <button>, <input>, <a>,
      // <select>, and <textarea> elements automatically, so interactive
      // children remain clickable. A div-based trigger placed here would have
      // to stop mousedown propagation itself. Windows' custom chrome uses the
      // same region.
      {...(IS_MACOS || customChrome ? { 'data-tauri-drag-region': true } : {})}
    >
      <div
        className={cn(
          'flex items-center w-full gap-1',
        )}
      >
        {!open && !hideControls && (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              className='rounded-full relative z-50'
              onClick={() => setLeftPanel(!open)}
              aria-label="Toggle sidebar"
            >
              <IconLayoutSidebar
                className="text-muted-foreground relative size-4.5"
              />
            </Button>
          </>
        )}
        <div
          className={cn(
            'flex-1 min-w-0'
          )}
        >
          {children}
        </div>
      </div>
    </div>
  )
})

export default HeaderPage
