import { describe, expect, it, vi } from 'vitest'
import {
  applyApiKeyToSettings,
  buildApiKeyUpdate,
  saveProviderApiKey,
} from '../provider-api-key'

vi.mock('@/lib/onboarding-telemetry', () => ({
  captureProviderKeyConfigured: vi.fn(),
}))

const makeProvider = (
  overrides: Partial<ModelProvider> = {}
): ModelProvider => ({
  active: true,
  provider: 'openai',
  api_key: '',
  base_url: 'https://api.openai.com/v1',
  settings: [
    {
      key: 'api-key',
      title: 'API Key',
      description: '',
      controller_type: 'input',
      controller_props: { placeholder: 'Insert API Key', value: '' },
    },
    {
      key: 'base-url',
      title: 'Base URL',
      description: '',
      controller_type: 'input',
      controller_props: { value: 'https://api.openai.com/v1' },
    },
  ],
  models: [],
  ...overrides,
})

describe('applyApiKeyToSettings', () => {
  it('writes the key into the api-key entry only', () => {
    const settings = makeProvider().settings
    const next = applyApiKeyToSettings(settings, 'sk-test')

    expect(next[0].controller_props.value).toBe('sk-test')
    expect(next[1].controller_props.value).toBe('https://api.openai.com/v1')
  })

  it('does not mutate the input, down to the controller_props object', () => {
    // The settings page's own handler mutates through a shallow copy, so the
    // previous state object sees the edit too. This helper must not.
    const settings = makeProvider().settings
    applyApiKeyToSettings(settings, 'sk-test')

    expect(settings[0].controller_props.value).toBe('')
  })

  it('returns the input untouched when there is no api-key setting', () => {
    const settings = [
      {
        key: 'base-url',
        title: 'Base URL',
        description: '',
        controller_type: 'input',
        controller_props: { value: 'https://example.com' },
      },
    ] as ModelProvider['settings']

    expect(applyApiKeyToSettings(settings, 'sk-test')).toBe(settings)
  })
})

describe('buildApiKeyUpdate', () => {
  it('sets both the settings entry and the top-level mirror', () => {
    // Writing one without the other yields a provider that looks configured
    // but cannot send a request, or vice versa.
    const update = buildApiKeyUpdate(makeProvider(), 'sk-test')

    expect(update.api_key).toBe('sk-test')
    expect(update.settings[0].controller_props.value).toBe('sk-test')
  })
})

describe('saveProviderApiKey', () => {
  const makeHub = (updateSettings = vi.fn(() => Promise.resolve())) => ({
    providers: () => ({ updateSettings }) as never,
  })

  it('persists the key through updateProvider', () => {
    const updateProvider = vi.fn()
    saveProviderApiKey({
      provider: makeProvider(),
      apiKey: 'sk-test',
      duringOnboarding: true,
      updateProvider,
      serviceHub: makeHub(),
    })

    const [name, patch] = updateProvider.mock.calls[0]
    expect(name).toBe('openai')
    expect(patch.api_key).toBe('sk-test')
    expect(patch.settings[0].controller_props.value).toBe('sk-test')
  })

  it('still persists when the extension settings write rejects', () => {
    // Cloud providers have no engine extension, so updateSettings is a no-op
    // for them and must never gate the save.
    const updateProvider = vi.fn()
    const failing = vi.fn(() => Promise.reject(new Error('no engine')))

    expect(() =>
      saveProviderApiKey({
        provider: makeProvider(),
        apiKey: 'sk-test',
        duringOnboarding: false,
        updateProvider,
        serviceHub: makeHub(failing),
      })
    ).not.toThrow()

    expect(updateProvider.mock.calls[0][1].api_key).toBe('sk-test')
  })
})
