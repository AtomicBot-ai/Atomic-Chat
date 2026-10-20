import { useLocation } from '@tanstack/react-router'
import { Bot, Plug, Puzzle } from 'lucide-react'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { SidebarMenu } from '@/components/ui/sidebar'
import {
  NavGroupLabel,
  NavRow,
  NewBadge,
} from '@/components/left-sidebar/NavRow'
import { isPathActive } from '@/lib/navigation'

/**
 * The Settings section of the contextual sidebar: app preferences, then the
 * workspace pieces a chat plugs into (assistants, MCP connectors, skills).
 */
export function SettingsNavigation() {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const connectorsBadgeSeen = useGeneralSetting(
    (state) => state.connectorsBadgeSeen
  )

  const preferences = [
    ['common:general', route.settings.general],
    ['common:attachments', route.settings.attachments],
    ['common:interface', route.settings.interface],
    ['common:keyboardShortcuts', route.settings.shortcuts],
    ['common:hardware', route.settings.hardware],
  ] as const

  return (
    <>
      <SidebarMenu className="px-2">
        {preferences.map(([label, to]) => (
          <NavRow
            key={to}
            to={to}
            label={t(label)}
            active={isPathActive(pathname, to)}
          />
        ))}
      </SidebarMenu>
      <NavGroupLabel>{t('common:navigation.workspace')}</NavGroupLabel>
      <SidebarMenu className="px-2">
        <NavRow
          to={route.settings.assistant}
          label={t('common:assistants')}
          icon={<Bot size={16} />}
          active={isPathActive(pathname, route.settings.assistant)}
        />
        <NavRow
          to={route.connectors.index}
          label={t('common:navigation.mcpConnectors')}
          icon={<Plug size={16} />}
          active={isPathActive(pathname, route.connectors.index, true)}
          trailing={!connectorsBadgeSeen && <NewBadge />}
        />
        <NavRow
          to={route.skills.index}
          label={t('common:skills')}
          icon={<Puzzle size={16} />}
          active={isPathActive(pathname, route.skills.index, true)}
        />
      </SidebarMenu>
    </>
  )
}
