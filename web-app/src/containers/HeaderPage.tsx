import { cn } from '@/lib/utils'
import { ReactNode, memo } from 'react'

type HeaderPageProps = {
  children?: ReactNode
}

// The sidebar toggle and the macOS traffic-light inset live in the window
// title bar row above every page (components/left-sidebar/WindowTitlebar), so
// a page header only carries the page's own title and actions.
const HeaderPage = memo(function HeaderPage({ children }: HeaderPageProps) {
  return (
    <div
      className={cn(
        'relative h-15 flex shrink-0 items-center pl-4 pr-4',
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
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  )
})

export default HeaderPage
