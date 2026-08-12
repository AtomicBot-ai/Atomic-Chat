import { Link } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'

import { useGeneralSetting } from '@/hooks/useGeneralSetting'

const SettingsMenu = () => {
  const { t } = useTranslation()
  const { settingsMode } = useGeneralSetting()
  const isAdvanced = settingsMode === 'advanced'

  const menuSettings = [
    {
      title: 'common:general',
      route: route.settings.general,
      isEnabled: true,
    },
    {
      title: 'common:attachments',
      route: route.settings.attachments,
      isEnabled: isAdvanced,
    },
    // Privacy — вкладка скрыта
    // {
    //   title: 'common:privacy',
    //   route: route.settings.privacy,
    //   isEnabled: true,
    // },
    {
      title: 'common:assistants',
      route: route.settings.assistant,
      isEnabled: true,
    },
    {
      title: 'common:keyboardShortcuts',
      route: route.settings.shortcuts,
      isEnabled: isAdvanced,
    },
    {
      title: 'common:hardware',
      route: route.settings.hardware,
      isEnabled: isAdvanced,
    },
    {
      title: 'common:mcp-servers',
      route: route.settings.mcp_servers,
      isEnabled: true,
    },
    {
      title: 'common:modelProviders',
      route: route.settings.model_providers,
      isEnabled: true,
    },
    {
      title: 'common:https_proxy',
      route: route.settings.https_proxy,
      isEnabled: isAdvanced,
    },
  ]

  return (
    <div className="h-full w-58 shrink-0 px-1.5 flex overflow-auto">
      <div className="flex flex-col gap-1 w-full font-medium">
        {menuSettings.map((menu) => {
          if (!menu.isEnabled) {
            return null
          }
          return (
            /* Selected uses a background-relative `foreground` overlay
               (heavier than the hover) so it stays legible on the panel,
               matching the sidebar's selected treatment. */
            <Link
              key={menu.title}
              to={menu.route}
              className="block px-2 gap-1.5 cursor-pointer hover:dark:bg-secondary/60 hover:bg-secondary py-1 w-full rounded-sm [&.active]:bg-foreground/20"
            >
              <span>{t(menu.title)}</span>
            </Link>
          )
        })}
      </div>
    </div>
  )
}

export default SettingsMenu
