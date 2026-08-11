import { createFileRoute, Outlet } from '@tanstack/react-router'
import { useState } from 'react'
import { route } from '@/constants/routes'
import HeaderPage from '@/containers/HeaderPage'
import SettingsMenu from '@/containers/SettingsMenu'
import { SettingsHeaderSlotProvider } from '@/containers/SettingsPageHeader'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.index as any)({
  component: SettingsLayout,
})

function SettingsLayout() {
  /// The chrome shared by every settings page lives here rather than in the
  /// pages themselves. When each page rendered its own `SettingsMenu`, the menu
  /// was part of the same commit as the page body — including the provider
  /// screen, which is large enough that the navigation transition took visibly
  /// long to commit, so a click on a menu row appeared to do nothing until the
  /// whole page was ready. Owned by the layout, the menu survives navigation
  /// and only the `Outlet` is re-rendered.
  const [headerSlot, setHeaderSlot] = useState<HTMLDivElement | null>(null)

  return (
    <div className="flex flex-col h-svh w-full">
      <HeaderPage>
        {/* `display: contents` keeps the slot out of the box tree, so a page's
            header markup lays out exactly as it did when it rendered its own
            `HeaderPage`. */}
        <div ref={setHeaderSlot} style={{ display: 'contents' }} />
      </HeaderPage>
      <div className="flex h-[calc(100%-60px)]">
        <SettingsMenu />
        <SettingsHeaderSlotProvider value={headerSlot}>
          <Outlet />
        </SettingsHeaderSlotProvider>
      </div>
    </div>
  )
}
