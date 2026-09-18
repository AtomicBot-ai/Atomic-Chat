import { useLeftPanel } from '@/hooks/useLeftPanel'
import { cn } from '@/lib/utils'
import { IconLayoutSidebar } from '@tabler/icons-react'
import { ReactNode, memo } from 'react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

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

  return (
    <div
      className={cn(
        'relative h-15 flex shrink-0 items-center pr-4',
        !open && !hideControls && IS_MACOS ? 'pl-20' : 'pl-4',
        children === undefined && 'border-none'
      )}
      // On macOS the element-based drag region approach is used: this div sits
      // inside the SidebarInset which is in normal document flow, so it is
      // always at its natural z-level and can receive mousedown events.
      // Tauri's drag handler excludes clicks on <button>, <input>, <a>,
      // <select>, and <textarea> elements automatically, so interactive
      // children remain clickable. A div-based trigger placed here would have
      // to stop mousedown propagation itself.
      {...(IS_MACOS ? { 'data-tauri-drag-region': true } : {})}
    >
      <div className="flex w-full min-w-0 items-center gap-2">
        {!open && !hideControls && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="relative z-50 shrink-0 rounded-full"
                onClick={() => setLeftPanel(!open)}
                aria-label="Toggle sidebar"
              >
                <IconLayoutSidebar className="relative size-4.5 text-muted-foreground" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Toggle sidebar</TooltipContent>
          </Tooltip>
        )}
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  )
})

export default HeaderPage
