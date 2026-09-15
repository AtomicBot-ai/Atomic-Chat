import type { ReactNode } from 'react'

import HeaderPage from '@/containers/HeaderPage'
import SettingsMenu from '@/containers/SettingsMenu'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

type SettingsPageLayoutProps = {
  /** The page's own heading, shown above its content. */
  title?: string
  /** Controls that belong to the page, shown at the right of the header. */
  actions?: ReactNode
  children: ReactNode
}

/**
 * The Settings frame — header, settings menu, scrolling content — for pages
 * that used to be screens of their own (Cloud, API) or a panel in the chat
 * (run settings), so they sit in Settings like every other page there.
 */
export function SettingsPageLayout({
  title,
  actions,
  children,
}: SettingsPageLayoutProps) {
  const { t } = useTranslation()

  return (
    <div className="flex h-svh w-full flex-col">
      <HeaderPage>
        <div
          className={cn(
            'flex items-center justify-between w-full mr-2 pr-3',
            !IS_MACOS && 'pr-30'
          )}
        >
          <span className="font-medium text-base font-studio">
            {t('common:settings')}
          </span>
          {actions}
        </div>
      </HeaderPage>
      <div className="flex h-[calc(100%-60px)]">
        <SettingsMenu />
        <div className="w-full min-w-0 overflow-y-auto p-4 pt-0">
          {title && (
            <h1 className="mb-3 text-base font-medium font-studio">{title}</h1>
          )}
          {children}
        </div>
      </div>
    </div>
  )
}
