/** The `base-url` setting entry and the top-level mirror, written together. */
export function buildBaseUrlUpdate(
  provider: ProviderObject,
  rawUrl: string
): Pick<ModelProvider, 'settings' | 'base_url'> {
  // Trim so a stray leading/trailing space (common on paste) doesn't leak into
  // request URLs as `/v1 /models` → 404. Normalise the stored setting value
  // too, not just the mirror field.
  const baseUrl = rawUrl.trim()
  const index = provider.settings.findIndex((s) => s.key === 'base-url')
  if (index === -1) return { settings: provider.settings, base_url: baseUrl }

  const settings = [...provider.settings]
  settings[index] = {
    ...settings[index],
    controller_props: { ...settings[index].controller_props, value: baseUrl },
  }
  return { settings, base_url: baseUrl }
}
