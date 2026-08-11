import { createFileRoute } from '@tanstack/react-router'
import { SettingsPageHeader } from '@/containers/SettingsPageHeader'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { LocalApiServerPanel } from '@/containers/LocalApiServerPanel'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.local_api_server as any)({
  component: LocalAPIServerContent,
})

function LocalAPIServerContent() {
  const { t } = useTranslation()

  return (
    <>
      <SettingsPageHeader>
        <div
          className={cn(
            'flex items-center justify-between w-full mr-2 pr-3',
            !IS_MACOS && 'pr-30'
          )}
        >
          <span className="font-medium text-base font-studio">
            {t('common:settings')}
          </span>
        </div>
      </SettingsPageHeader>
      <div className="flex-1 flex flex-col min-h-0 pl-0">
        <div className="flex-1 overflow-y-auto p-4 pt-0">
          <LocalApiServerPanel />
        </div>
      </div>
    </>
  )
}
