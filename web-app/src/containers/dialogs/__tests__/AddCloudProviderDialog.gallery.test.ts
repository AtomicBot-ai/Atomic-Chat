/**
 * Which cloud providers the first-run gallery offers, and in what order.
 *
 * The order used to be the registry's own — flagship-first by somebody's sense
 * of which brand matters. Measured demand from `provider_key_configured` puts
 * OpenRouter first by a distance and OpenAI sixth, so the providers people
 * actually connect were the ones below the fold.
 */
import { describe, expect, it, vi } from 'vitest'

// Evaluated at import time and, off Tauri, false — which would hide the
// subscription and make the "subscriptions come first" case untestable.
vi.mock('@/lib/platform/const', () => ({
  PlatformFeatures: new Proxy({}, { get: () => true }) as Record<
    string,
    boolean
  >,
}))

import { selectCloudGalleryProviders } from '../AddCloudProviderDialog'

const apiKeySetting = {
  key: 'api-key',
  title: 'API Key',
  description: '',
  controller_type: 'input',
  controller_props: { value: '' },
}

const provider = (
  name: string,
  overrides: Partial<ModelProvider> = {}
): ModelProvider =>
  ({
    active: true,
    provider: name,
    api_key: '',
    base_url: `https://api.${name}.test/v1`,
    settings: [apiKeySetting],
    models: [],
    ...overrides,
  }) as ModelProvider

const names = (providers: ModelProvider[]) =>
  selectCloudGalleryProviders(providers).map((p) => p.provider)

describe('selectCloudGalleryProviders', () => {
  it('orders by measured demand, not by the registry', () => {
    // Keys configured to date: openrouter 72, gemini 54, huggingface 45,
    // openai 30, anthropic 17.
    expect(
      names([
        provider('anthropic'),
        provider('openai'),
        provider('openrouter'),
        provider('gemini'),
      ])
    ).toEqual(['openrouter', 'gemini', 'openai', 'anthropic'])
  })

  it('leaves providers with no demand figure where the registry put them', () => {
    // A new provider has not had the chance to be connected by anybody;
    // inventing a rank for it would be worse than keeping its position.
    expect(
      names([
        provider('brand-new'),
        provider('another-new'),
        provider('openrouter'),
      ])
    ).toEqual(['openrouter', 'brand-new', 'another-new'])
  })

  it('keeps the subscription first, ahead of the ranked keys', () => {
    // Signing in is the shortest exit from onboarding there is — there is no
    // dashboard to go and find a key on.
    expect(
      names([
        provider('openrouter'),
        provider('chatgpt', { settings: [], base_url: 'https://chatgpt.com' }),
      ])
    ).toEqual(['chatgpt', 'openrouter'])
  })

  it('still drops providers this dialog cannot actually connect', () => {
    expect(
      names([
        provider('openrouter'),
        // Azure's base_url is a per-account placeholder: a key-only save
        // produces a provider that looks connected and fails on first request.
        provider('azure'),
        // Loopback: the "cloud" is this machine.
        provider('ollama', { base_url: 'http://127.0.0.1:11434' }),
        // No `api-key` setting and not a subscription: nothing to save.
        provider('keyless', { settings: [] }),
      ])
    ).toEqual(['openrouter'])
  })
})
