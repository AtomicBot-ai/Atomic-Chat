import llamacppSettings from './core-settings-schema/llamacpp.json'
import llamacppUpstreamSettings from './core-settings-schema/llamacpp-upstream.json'
import mlxSettings from './core-settings-schema/mlx.json'

import { sameSettingValue } from '@/lib/model-settings-defaults'

/**
 * "Reset to default" for a local engine's settings, the list on its page
 * under Settings → Model providers: the defaults in `atomic-chat-core`'s
 * settings contract, which is what a fresh install registers.
 *
 * Read from a vendored copy of the core's schema files
 * (`./core-settings-schema/`, pinned to `atomicCore.version` in the root
 * `package.json`) rather than asked from the running extension: each
 * extension bundles its own copy of core, which keeps no defaults once the
 * persisted values are merged in.
 */

type SettingDefinition = { key: string; controllerProps?: { value?: unknown } }

/**
 * Settings a reset leaves alone: the installed backend is a download rather
 * than a preference, and the GPU selection is made on the Hardware page.
 */
const KEPT_ON_RESET = new Set(['version_backend', 'device'])

const toDefaults = (definitions: SettingDefinition[]) =>
  Object.fromEntries(
    definitions
      .filter((definition) => !KEPT_ON_RESET.has(definition.key))
      .map((definition) => [definition.key, definition.controllerProps?.value])
  )

const ENGINE_DEFAULTS: Record<string, Record<string, unknown>> = {
  'llamacpp': toDefaults(llamacppSettings as SettingDefinition[]),
  'llamacpp-upstream': toDefaults(
    llamacppUpstreamSettings as SettingDefinition[]
  ),
  'mlx': toDefaults(mlxSettings as SettingDefinition[]),
}

const defaultsFor = (providerName: string) =>
  Object.hasOwn(ENGINE_DEFAULTS, providerName)
    ? ENGINE_DEFAULTS[providerName]
    : undefined

/** Whether this provider's settings have known defaults to go back to. */
export function hasEngineSettingDefaults(providerName: string): boolean {
  return defaultsFor(providerName) !== undefined
}

/** Keys of `settings` that are off their default: what a reset changes. */
export function customEngineSettingKeys(
  providerName: string,
  settings: ProviderSetting[] = []
): string[] {
  const defaults = defaultsFor(providerName)
  if (!defaults) return []
  return settings
    .filter(
      (setting) =>
        Object.hasOwn(defaults, setting.key) &&
        !sameSettingValue(setting.controller_props?.value, defaults[setting.key])
    )
    .map((setting) => setting.key)
}

/**
 * `settings` with everything back on its default. Settings the engine added
 * on its own, and the ones in `KEPT_ON_RESET`, stay as they are.
 */
export function withDefaultEngineSettings(
  providerName: string,
  settings: ProviderSetting[]
): ProviderSetting[] {
  const defaults = defaultsFor(providerName)
  if (!defaults) return settings
  return settings.map((setting) =>
    Object.hasOwn(defaults, setting.key)
      ? {
          ...setting,
          controller_props: {
            ...setting.controller_props,
            value: defaults[setting.key],
          },
        }
      : setting
  ) as ProviderSetting[]
}
