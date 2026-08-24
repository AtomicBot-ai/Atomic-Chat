import { createFileRoute } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import HeaderPage from '@/containers/HeaderPage'
import SettingsMenu from '@/containers/SettingsMenu'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { VoiceSettingsPanel } from '@/containers/VoiceSettingsPanel'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.voice as any)({
  component: VoiceSettingsContent,
})

function VoiceSettingsContent() {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col h-svh w-full">
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
        </div>
      </HeaderPage>
      <div className="flex h-[calc(100%-60px)]">
        <SettingsMenu />
        <div className="flex-1 flex flex-col min-h-0 pl-0">
          <div className="flex-1 overflow-y-auto p-4 pt-0">
            <VoiceSettingsPanel />
          </div>
        </div>
      </div>
    </div>
  )
}
