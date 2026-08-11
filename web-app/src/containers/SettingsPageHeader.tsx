import { createContext, ReactNode, useContext } from 'react'
import { createPortal } from 'react-dom'
import HeaderPage from '@/containers/HeaderPage'

/// The `/settings` layout owns the single `HeaderPage` shared by every settings
/// page, so a page hands its header content up through this slot instead of
/// rendering a header of its own.
///
/// `undefined` means there is no layout above — a page rendered on its own, as
/// unit tests do — and an inline `HeaderPage` is then the correct output.
const SettingsHeaderSlotContext = createContext<HTMLElement | null | undefined>(
  undefined
)

export const SettingsHeaderSlotProvider = SettingsHeaderSlotContext.Provider

export function SettingsPageHeader({ children }: { children?: ReactNode }) {
  const slot = useContext(SettingsHeaderSlotContext)
  if (slot === undefined) return <HeaderPage>{children}</HeaderPage>
  if (slot === null) return null
  return createPortal(children, slot)
}

export default SettingsPageHeader
