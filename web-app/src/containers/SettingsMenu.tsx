import { Link } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useState, useEffect } from 'react'
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react'
import { useMatches, useNavigate } from '@tanstack/react-router'
import { cn } from '@/lib/utils'
import { PlatformFeatures } from '@/lib/platform/const'
import { PlatformFeature } from '@/lib/platform/types'

import { useModelProvider } from '@/hooks/useModelProvider'
import { getProviderTitle } from '@/lib/utils'
import { sortProvidersForSettings } from '@/lib/providerOrder'
import ProvidersAvatar from '@/containers/ProvidersAvatar'
import { isLocalEngineProvider } from '@/lib/cloud-providers'

const SettingsMenu = () => {
  const { t } = useTranslation()
  const [expandedProviders, setExpandedProviders] = useState(true)

  const matches = useMatches()
  const navigate = useNavigate()

  const { providers, selectedProvider } = useModelProvider()

  // Settings owns the local inference engines only. Connecting a cloud
  // provider — including Ollama and user-created OpenAI-compatible endpoints —
  // lives on `/cloud`, and `isCloudProvider` is the exact complement of this
  // filter, so nothing is listed in neither place.
  const localProviders = providers.filter(isLocalEngineProvider)

  const activeProviders = sortProvidersForSettings(
    localProviders.filter((provider) => {
      if (!provider.active) return false
      if (!IS_MACOS && provider.provider === 'mlx') return false
      return true
    })
  )

  const hiddenProviders = sortProvidersForSettings(
    localProviders.filter((provider) => {
      if (provider.active) return false
      if (!IS_MACOS && provider.provider === 'mlx') return false
      return true
    })
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
      isEnabled: true,
    },
    {
      title: 'common:voice',
      route: route.settings.voice,
      hasSubMenu: false,
      isEnabled: PlatformFeatures[PlatformFeature.VOICE_INPUT],
    },
    {
      title: 'common:interface',
      route: route.settings.interface,
      hasSubMenu: false,
      isEnabled: true,
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
      isEnabled: true,
    },
    {
      title: 'common:hardware',
      route: route.settings.hardware,
      hasSubMenu: false,
      isEnabled: true,
    },
    {
      title: 'common:https_proxy',
      route: route.settings.https_proxy,
      hasSubMenu: false,
      isEnabled: true,
    },
  ]

  const toggleProvidersExpansion = () => {
    setExpandedProviders(!expandedProviders)
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
            <div className="flex items-center justify-between pl-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t('common:modelProviders')}
              </span>
            </div>
            <div className="mt-1 flex flex-col gap-0.5">
              {activeProviders.map((provider) => {
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
                      'flex px-2 items-center gap-1.5 cursor-pointer hover:bg-secondary/60 py-1 w-full rounded-sm text-foreground',
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
                    <div className="truncate">
                      <span>{getProviderTitle(provider.provider)}</span>
                    </div>
                    {/* Same marker as the model select dropdown: the
                        provider currently backing the selected model. */}
                    {provider.provider === selectedProvider && (
                      <span
                        data-testid={`provider-active-dot-${provider.provider}`}
                        className="size-2 rounded-full bg-green-500 shrink-0"
                      />
                    )}
                  </div>
                )
              })}

              {hiddenProviders.length > 0 && (
                <>
                  <button
                    className="flex items-center justify-between px-2 py-1 w-full rounded-sm text-muted-foreground hover:bg-secondary/60"
                    onClick={() => setExpandedProviders(!expandedProviders)}
                  >
                    <span className="text-sm">
                      {t('common:hiddenProviders', {
                        count: hiddenProviders.length,
                      })}
                    </span>
                    {expandedProviders ? (
                      <IconChevronDown size={14} />
                    ) : (
                      <IconChevronRight size={14} />
                    )}
                  </button>
                  {expandedProviders &&
                    hiddenProviders.map((provider) => {
                      const isRouteActive = matches.some(
                        (match) =>
                          match.routeId ===
                            '/settings/providers/$providerName' &&
                          'providerName' in match.params &&
                          match.params.providerName === provider.provider
                      )
                      return (
                        <div
                          key={provider.provider}
                          className={cn(
                            'flex px-2 items-center gap-1.5 cursor-pointer hover:bg-secondary/60 py-1 w-full rounded-sm text-muted-foreground',
                            isRouteActive && 'bg-foreground/20'
                          )}
                          onClick={() =>
                            navigate({
                              to: route.settings.providers,
                              params: { providerName: provider.provider },
                            })
                          }
                        >
                          <ProvidersAvatar provider={provider} />
                          <div className="truncate flex-1">
                            <span>{getProviderTitle(provider.provider)}</span>
                          </div>
                        </div>
                      )
                    })}
                </>
              )}
            </div>
            <div className="m-3" />
          </div>
        </div>
      </div>
    </>
  )
}

export default SettingsMenu
