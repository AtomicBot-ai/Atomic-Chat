import { Link } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  IconChevronDown,
  IconChevronRight,
  IconCloud,
  IconDeviceLaptop,
  IconPlus,
} from '@tabler/icons-react'
import { useMatches, useNavigate } from '@tanstack/react-router'
import { cn } from '@/lib/utils'

import { useModelProvider } from '@/hooks/useModelProvider'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { getProviderTitle } from '@/lib/utils'
import ProvidersAvatar from '@/containers/ProvidersAvatar'
import { AddCloudProviderDialog } from '@/containers/dialogs'
import { isLocalProvider } from '@/utils/registerRemoteProvider'
import { openAIProviderSettings } from '@/constants/providers'
import cloneDeep from 'lodash/cloneDeep'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

const SettingsMenu = () => {
  const { t } = useTranslation()
  const [expandedProviders, setExpandedProviders] = useState(true)

  const matches = useMatches()
  const navigate = useNavigate()

  const { providers, addProvider } = useModelProvider()
  const { settingsMode } = useGeneralSetting()
  const isAdvanced = settingsMode === 'advanced'

  const createProvider = useCallback(
    (name: string) => {
      if (
        providers.some((e) => e.provider.toLowerCase() === name.toLowerCase())
      ) {
        toast.error(t('provider:providerAlreadyExists', { name }))
        return
      }
      const newProvider: ProviderObject = {
        provider: name,
        active: true,
        models: [],
        settings: cloneDeep(openAIProviderSettings) as ProviderSetting[],
        api_key: '',
        base_url: 'https://api.openai.com/v1',
      }
      addProvider(newProvider)
      setTimeout(() => {
        navigate({
          to: route.settings.providers,
          params: { providerName: name },
        })
      }, 0)
    },
    [providers, addProvider, t, navigate]
  )

  const visibleProviders = useMemo(
    () =>
      providers.filter(
        (provider) => IS_MACOS || provider.provider !== 'mlx'
      ),
    [providers]
  )

  // Local engines are always listed — their switch only enables/disables them,
  // it never takes them off the menu. Cloud providers are the opposite: they
  // only appear once the user has connected them from the catalog, so the menu
  // stays short instead of listing every entry in the registry.
  const localProviders = useMemo(
    () => visibleProviders.filter((provider) => isLocalProvider(provider.provider)),
    [visibleProviders]
  )

  const cloudProviders = useMemo(
    () =>
      visibleProviders.filter(
        (provider) => !isLocalProvider(provider.provider) && provider.active
      ),
    [visibleProviders]
  )

  const activeProviders = useMemo(
    () => visibleProviders.filter((provider) => provider.active),
    [visibleProviders]
  )

  // Check if current route has a providerName parameter and expand providers submenu
  useEffect(() => {
    const hasProviderName = matches.some(
      (match) =>
        match.routeId === '/settings/providers/$providerName' &&
        'providerName' in match.params
    )
    const isProvidersRoute = matches.some(
      (match) => match.routeId === '/settings/providers/'
    )
    if (hasProviderName || isProvidersRoute) {
      setExpandedProviders(true)
    }
  }, [matches])

  // Check if we're in the setup remote provider step
  const stepSetupRemoteProvider = matches.some(
    (match) =>
      match.search &&
      typeof match.search === 'object' &&
      'step' in match.search &&
      match.search.step === 'setup_remote_provider'
  )

  const menuSettings = [
    {
      title: 'common:general',
      route: route.settings.general,
      hasSubMenu: false,
      isEnabled: true,
    },
    {
      title: 'common:attachments',
      route: route.settings.attachments,
      hasSubMenu: false,
      isEnabled: isAdvanced,
    },
    // Privacy — вкладка скрыта
    // {
    //   title: 'common:privacy',
    //   route: route.settings.privacy,
    //   hasSubMenu: false,
    //   isEnabled: true,
    // },
    {
      title: 'common:assistants',
      route: route.settings.assistant,
      hasSubMenu: false,
      isEnabled: true,
    },
    {
      title: 'common:keyboardShortcuts',
      route: route.settings.shortcuts,
      hasSubMenu: false,
      isEnabled: isAdvanced,
    },
    {
      title: 'common:hardware',
      route: route.settings.hardware,
      hasSubMenu: false,
      isEnabled: isAdvanced,
    },
    {
      title: 'common:mcp-servers',
      route: route.settings.mcp_servers,
      hasSubMenu: false,
      isEnabled: true,
    },
    {
      title: 'common:https_proxy',
      route: route.settings.https_proxy,
      hasSubMenu: false,
      isEnabled: isAdvanced,
    },
  ]

  const toggleProvidersExpansion = () => {
    setExpandedProviders(!expandedProviders)
  }

  const renderProviderItem = (provider: ProviderObject, muted = false) => {
    const isRouteActive = matches.some(
      (match) =>
        match.routeId === '/settings/providers/$providerName' &&
        'providerName' in match.params &&
        match.params.providerName === provider.provider
    )
    return (
      <div
        key={provider.provider}
        className={cn(
          'flex px-2 items-center gap-1.5 cursor-pointer hover:bg-secondary/60 py-1 w-full rounded-sm',
          muted ? 'text-muted-foreground' : 'text-foreground',
          isRouteActive && 'bg-foreground/20',
          provider.provider === 'llama.cpp' &&
            stepSetupRemoteProvider &&
            'hidden'
        )}
        onClick={() =>
          navigate({
            to: route.settings.providers,
            params: { providerName: provider.provider },
            ...(stepSetupRemoteProvider
              ? { search: { step: 'setup_remote_provider' } }
              : {}),
          })
        }
      >
        <ProvidersAvatar provider={provider} />
        <div className="truncate flex-1">
          <span>{getProviderTitle(provider.provider)}</span>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="h-full w-58 shrink-0 px-1.5 flex overflow-auto">
        <div className="flex flex-col gap-1 w-full font-medium">
          {menuSettings.map((menu) => {
            if (!menu.isEnabled) {
              return null
            }
            return (
              <div key={menu.title}>
                {/* Selected uses a background-relative `foreground` overlay
                    (heavier than the hover) so it stays legible on the panel,
                    matching the sidebar's selected treatment. */}
                <Link
                  to={menu.route}
                  className="block px-2 gap-1.5 cursor-pointer hover:dark:bg-secondary/60 hover:bg-secondary py-1 w-full rounded-sm [&.active]:bg-foreground/20"
                >
                  <div className="flex items-center justify-between">
                    <span>{t(menu.title)}</span>
                    {menu.hasSubMenu && (
                      <button
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          toggleProvidersExpansion()
                        }}
                        className="text-muted-foreground/60 hover:text-muted-foreground/80"
                      >
                        {expandedProviders ? (
                          <IconChevronDown size={16} />
                        ) : (
                          <IconChevronRight size={16} />
                        )}
                      </button>
                    )}
                  </div>
                </Link>

                {/* Sub-menu for model providers */}
                {menu.hasSubMenu && expandedProviders && (
                  <div className="ml-2 mt-1 space-y-1">
                    {activeProviders.map((provider) => {
                      const isActive = matches.some(
                        (match) =>
                          match.routeId ===
                            '/settings/providers/$providerName' &&
                          'providerName' in match.params &&
                          match.params.providerName === provider.provider
                      )

                      return (
                        <div key={provider.provider}>
                          <div
                            className={cn(
                              'flex px-2 items-center gap-1.5 cursor-pointer hover:bg-secondary/60 py-1 w-full rounded-sm text-foreground',
                              isActive && 'bg-foreground/20',
                              // hidden for llama.cpp provider for setup remote provider
                              provider.provider === 'llama.cpp' &&
                                stepSetupRemoteProvider &&
                                'hidden'
                            )}
                            onClick={() =>
                              navigate({
                                to: route.settings.providers,
                                params: {
                                  providerName: provider.provider,
                                },
                                ...(stepSetupRemoteProvider
                                  ? {
                                      search: { step: 'setup_remote_provider' },
                                    }
                                  : {}),
                              })
                            }
                          >
                            <ProvidersAvatar provider={provider} />
                            <div className="truncate">
                              <span>{getProviderTitle(provider.provider)}</span>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}

          {/* Model Providers section */}
          <div className="mt-4">
            <div className="pl-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t('common:modelProviders')}
              </span>
            </div>

            <div className="mt-2 flex items-center gap-1.5 pl-2 text-muted-foreground">
              <IconDeviceLaptop size={13} />
              <span className="text-xs font-semibold uppercase tracking-wider">
                {t('provider:local')}
              </span>
            </div>
            <div className="mt-1 flex flex-col gap-0.5">
              {localProviders.map((provider) =>
                renderProviderItem(provider, !provider.active)
              )}
            </div>

            <div className="mt-3 flex items-center justify-between pl-2">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <IconCloud size={13} />
                <span className="text-xs font-semibold uppercase tracking-wider">
                  {t('provider:cloud')}
                </span>
              </div>
              <AddCloudProviderDialog onCreateCustomProvider={createProvider}>
                <Button variant="ghost" size="icon-xs">
                  <IconPlus size={12} />
                </Button>
              </AddCloudProviderDialog>
            </div>
            <div className="mt-1 flex flex-col gap-0.5">
              {cloudProviders.map((provider) => renderProviderItem(provider))}
            </div>
            <div className="m-3" />
          </div>
        </div>
      </div>
    </>
  )
}

export default SettingsMenu
