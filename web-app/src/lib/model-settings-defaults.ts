import { modelSettings } from '@/lib/predefined'

/**
 * "Reset to default" for a local model's load-time settings (context size,
 * GPU layers, batch size, …): the values a freshly listed model is seeded
 * with, `modelSettings` in `predefined.ts`. The sampling knobs have their own
 * reset (`sampling-defaults.ts`), so neither touches the other.
 */

/**
 * Sampling parameters are edited globally in the chat's Run settings panel;
 * their legacy load-time twins under `model.settings.*` are hidden from the
 * model settings list and left out of its reset. Data on disk is preserved.
 */
export const LEGACY_SAMPLING_KEYS = new Set<string>([
  'temperature',
  'top_p',
  'top_k',
  'min_p',
  'repeat_penalty',
  'repeat_last_n',
  'presence_penalty',
  'frequency_penalty',
])

/** Settings a loaded model only picks up after a restart. */
export const RESTART_REQUIRED_SETTINGS = new Set([
  'ctx_len',
  'ngl',
  'chat_template',
  'offload_mmproj',
  'batch_size',
  'cpu_moe',
  'n_cpu_moe',
  'override_tensor_buffer_t',
  'no_kv_offload',
])

const DEFAULT_VALUES: Record<string, unknown> = Object.fromEntries(
  Object.values(modelSettings)
    .filter((setting) => !LEGACY_SAMPLING_KEYS.has(setting.key))
    .map((setting) => [setting.key, setting.controller_props.value])
)

/**
 * Inputs store what was typed, so `8192` and `'8192'` are the same value,
 * and an unset field (`''`) matches a missing one.
 */
export const sameSettingValue = (a: unknown, b: unknown) =>
  String(a ?? '') === String(b ?? '')

/**
 * Keys of `settings` that are off their default, i.e. what a reset would
 * change. Settings without a known default (anything an engine adds on its
 * own) never count.
 */
export function customModelSettingKeys(
  settings: Record<string, ProviderSetting> = {}
): string[] {
  return Object.entries(settings)
    .filter(
      ([key, setting]) =>
        key in DEFAULT_VALUES &&
        !sameSettingValue(setting?.controller_props?.value, DEFAULT_VALUES[key])
    )
    .map(([key]) => key)
}

/** `settings` with each of `keys` back on its default; the rest as they are. */
export function withDefaultModelSettings(
  settings: Record<string, ProviderSetting> = {},
  keys: string[]
): Record<string, ProviderSetting> {
  const reset = new Set(keys.filter((key) => key in DEFAULT_VALUES))
  return Object.fromEntries(
    Object.entries(settings).map(([key, setting]) => [
      key,
      reset.has(key)
        ? {
            ...setting,
            controller_props: {
              ...setting.controller_props,
              value: DEFAULT_VALUES[key],
            },
          }
        : setting,
    ])
  ) as Record<string, ProviderSetting>
}
