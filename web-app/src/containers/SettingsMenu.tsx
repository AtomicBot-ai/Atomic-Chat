import { useState } from 'react'
import { Link, useLocation } from '@tanstack/react-router'
import { Bot, ChevronRight, Image, Mic, Plug, Puzzle } from 'lucide-react'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn, getProviderTitle } from '@/lib/utils'
import { PlatformFeatures } from '@/lib/platform/const'
import { PlatformFeature } from '@/lib/platform/types'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useModelProvider } from '@/hooks/useModelProvider'
import { sortProvidersForSettings } from '@/lib/providerOrder'
import { isLocalEngineProvider } from '@/lib/cloud-providers'
import ProvidersAvatar from '@/containers/ProvidersAvatar'
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
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

function EngineRow({
  provider,
  active,
  selected,
  muted,
}: {
  provider: ModelProvider
  active: boolean
  selected: boolean
  muted?: boolean
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={active}
        className={cn(
          'data-[active=true]:bg-sidebar-foreground/15',
          muted && 'text-muted-foreground'
        )}
      >
        <Link
          to={route.settings.providers}
          params={{ providerName: provider.provider }}
        >
          <ProvidersAvatar provider={provider} />
          <span className="min-w-0 flex-1 truncate">
            {getProviderTitle(provider.provider)}
          </span>
          {/* Same marker as the model select dropdown: the provider
              currently backing the selected model. */}
          {selected && (
            <span
              data-testid={`provider-active-dot-${provider.provider}`}
              className="size-2 shrink-0 rounded-full bg-green-500"
            />
          )}
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

/**
 * The local inference engines (each opens its settings page), plus the media
 * and voice engine settings. Cloud providers — Ollama and user-created
 * OpenAI-compatible endpoints included — live under Cloud providers, and
 * `isCloudProvider` is the exact complement of the filter here, so nothing
 * is listed in neither place.
 */
export function EngineNavigation() {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const [showDisabled, setShowDisabled] = useState(true)
  const { providers, selectedProvider } = useModelProvider()

  const turboquant = PlatformFeatures[PlatformFeature.TURBOQUANT_ENGINE]
  const listed = providers.filter((provider) => {
    if (!isLocalEngineProvider(provider)) return false
    if (!IS_MACOS && provider.provider === 'mlx') return false
    if (!turboquant && provider.provider === 'llamacpp') return false
    return true
  })
  const enabled = sortProvidersForSettings(listed.filter((p) => p.active))
  const disabled = sortProvidersForSettings(listed.filter((p) => !p.active))

  const isOpen = (provider: ModelProvider) =>
    isPathActive(pathname, `/settings/providers/${provider.provider}`)

  return (
    <>
      <NavGroupLabel>{t('common:navigation.inferenceEngines')}</NavGroupLabel>
      <SidebarMenu className="px-2">
        {enabled.map((provider) => (
          <EngineRow
            key={provider.provider}
            provider={provider}
            active={isOpen(provider)}
            selected={provider.provider === selectedProvider}
          />
        ))}
        {disabled.length > 0 && (
          <SidebarMenuItem>
            <SidebarMenuButton
              className="text-muted-foreground"
              aria-expanded={showDisabled}
              onClick={() => setShowDisabled(!showDisabled)}
            >
              <span className="min-w-0 flex-1 truncate">
                {t('common:hiddenProviders', { count: disabled.length })}
              </span>
              <ChevronRight
                className={cn(
                  'size-3.5 shrink-0 transition-transform',
                  showDisabled && 'rotate-90'
                )}
              />
            </SidebarMenuButton>
          </SidebarMenuItem>
        )}
        {showDisabled &&
          disabled.map((provider) => (
            <EngineRow
              key={provider.provider}
              provider={provider}
              active={isOpen(provider)}
              selected={false}
              muted
            />
          ))}
        {PlatformFeatures[PlatformFeature.MEDIA_GENERATION] && (
          <NavRow
            to={route.settings.media}
            label={t('common:media')}
            icon={<Image size={16} />}
            active={isPathActive(pathname, route.settings.media)}
          />
        )}
        {PlatformFeatures[PlatformFeature.VOICE_INPUT] && (
          <NavRow
            to={route.settings.voice}
            label={t('common:voice')}
            icon={<Mic size={16} />}
            active={isPathActive(pathname, route.settings.voice)}
          />
        )}
      </SidebarMenu>
    </>
  )
}
