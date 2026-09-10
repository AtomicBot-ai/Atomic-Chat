import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

const mocks = vi.hoisted(() => ({
  // Flipped by a test to put the dialog on a platform that cannot serve the
  // OAuth callback (web, mobile).
  subscriptionSupported: { current: true },
  // Stable identity: the mocked store hands this very array to the component
  // and writes model lists back into it.
  providers: [] as ModelProvider[],
  auth: {
    chatgptStatus: vi.fn(),
    chatgptLogin: vi.fn(),
    chatgptCancelLogin: vi.fn(),
    chatgptLogout: vi.fn(),
    chatgptModels: vi.fn(),
  },
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/lib/platform/const', () => ({
  PlatformFeatures: new Proxy(
    {},
    { get: () => mocks.subscriptionSupported.current }
  ) as Record<string, boolean>,
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

vi.mock('@/hooks/useModelProvider', () => {
  const state = {
    providers: mocks.providers,
    getProviderByName: (name: string) =>
      state.providers.find((p) => p.provider === name),
    updateProvider: (name: string, patch: Partial<ModelProvider>) => {
      const index = state.providers.findIndex((p) => p.provider === name)
      if (index !== -1) {
        state.providers[index] = { ...state.providers[index], ...patch }
      }
    },
  }
  const useModelProvider = () => state
  useModelProvider.getState = () => state
  return { useModelProvider }
})

import { AddCloudProviderDialog } from '../AddCloudProviderDialog'
import { seedServiceHub } from '@/test/service-hub'

const openai = (): ModelProvider =>
  ({
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
        controller_props: { value: '' },
      },
    ],
    models: [{ id: 'gpt-5.5' }],
  }) as ModelProvider

// Seeded after the registry's own entries, exactly as `BASELINE_PROVIDERS` is.
const chatgpt = (): ModelProvider =>
  ({
    active: true,
    provider: 'chatgpt',
    api_key: '',
    base_url: 'https://chatgpt.com/backend-api/codex',
    settings: [],
    models: [],
  }) as ModelProvider

const seed = (providers: ModelProvider[]) => {
  mocks.providers.length = 0
  mocks.providers.push(...providers)
}

/** Gallery cards in DOM order — every one carries its subtitle key. */
const cardLabels = () =>
  screen
    .getAllByRole('button')
    .map((button) => button.textContent ?? '')
    .filter((text) =>
      /setup:cloudStep\.(subscriptionOnly|keyOnly|modelCount)/.test(text)
    )

describe('AddCloudProviderDialog — ChatGPT subscription', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.subscriptionSupported.current = true
    mocks.auth.chatgptStatus.mockResolvedValue({ connected: false })
    mocks.auth.chatgptModels.mockResolvedValue([])
    seedServiceHub({ auth: mocks.auth as never })
    seed([openai(), chatgpt()])
  })

  it('offers the subscription first, as a sign-in rather than a key', async () => {
    const { unmount } = render(
      <AddCloudProviderDialog
        open
        onOpenChange={vi.fn()}
        onKeySaved={vi.fn()}
      />
    )

    // Ahead of OpenAI even though the store lists it after: no key to go and
    // find makes it the shortest way out of onboarding.
    expect(cardLabels()).toEqual([
      'ChatGPT (Codex)setup:cloudStep.subscriptionOnly',
      'OpenAIsetup:cloudStep.modelCountOne',
    ])
    unmount()
  })

  it('is not offered where the sign-in cannot be served', async () => {
    mocks.subscriptionSupported.current = false

    const { unmount } = render(
      <AddCloudProviderDialog
        open
        onOpenChange={vi.fn()}
        onKeySaved={vi.fn()}
      />
    )

    expect(cardLabels()).toEqual(['OpenAIsetup:cloudStep.modelCountOne'])
    unmount()
  })

  it('signs in and leaves onboarding on the account first model', async () => {
    mocks.auth.chatgptLogin.mockResolvedValue({
      connected: true,
      email: 'someone@example.test',
      plan_type: 'Plus',
    })
    mocks.auth.chatgptModels.mockResolvedValue([
      { id: 'gpt-5.1-codex', display_name: 'GPT-5.1 Codex', listed: true },
      { id: 'unlisted', display_name: 'Unlisted', listed: false },
    ])
    const onKeySaved = vi.fn()
    const onOpenChange = vi.fn()

    const { unmount } = render(
      <AddCloudProviderDialog
        open
        onOpenChange={onOpenChange}
        onKeySaved={onKeySaved}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /ChatGPT/ }))

    // Disabled until the backend has reported the current connection state.
    const connect = await screen.findByRole('button', {
      name: 'setup:cloudStep.subscriptionConnect',
    })
    await waitFor(() => expect(connect).toBeEnabled())
    fireEvent.click(connect)

    await waitFor(() =>
      expect(onKeySaved).toHaveBeenCalledWith({
        providerName: 'chatgpt',
        modelId: 'gpt-5.1-codex',
      })
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
    unmount()
  })

  it('keeps the step open and shows what the backend said on failure', async () => {
    mocks.auth.chatgptLogin.mockRejectedValue(new Error('Port 1455 is busy'))
    const onKeySaved = vi.fn()

    const { unmount } = render(
      <AddCloudProviderDialog
        open
        onOpenChange={vi.fn()}
        onKeySaved={onKeySaved}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /ChatGPT/ }))
    const connect = await screen.findByRole('button', {
      name: 'setup:cloudStep.subscriptionConnect',
    })
    await waitFor(() => expect(connect).toBeEnabled())
    fireEvent.click(connect)

    expect(await screen.findByText('Port 1455 is busy')).toBeInTheDocument()
    expect(onKeySaved).not.toHaveBeenCalled()
    unmount()
  })
})
