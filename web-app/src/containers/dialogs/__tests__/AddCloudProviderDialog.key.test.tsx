import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { toast } from 'sonner'

const mocks = vi.hoisted(() => ({
  providers: [] as ModelProvider[],
  updateProvider: vi.fn(),
  checkProviderEndpoint: vi.fn(),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}))

vi.mock('@/hooks/useModelProvider', () => {
  const state = {
    providers: mocks.providers,
    getProviderByName: (name: string) =>
      state.providers.find((p) => p.provider === name),
    updateProvider: mocks.updateProvider,
  }
  const useModelProvider = () => state
  useModelProvider.getState = () => state
  return { useModelProvider }
})

import { AddCloudProviderDialog } from '../AddCloudProviderDialog'
import { seedServiceHub } from '@/test/service-hub'
import {
  keyStatusFor,
  useProviderKeyStatusStore,
} from '@/stores/provider-key-status-store'

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

function renderOnOpenAi() {
  const onKeySaved = vi.fn()
  const onOpenChange = vi.fn()
  render(
    <AddCloudProviderDialog
      open
      onOpenChange={onOpenChange}
      onKeySaved={onKeySaved}
      initialProviderName="openai"
    />
  )
  return { onKeySaved, onOpenChange }
}

const saveKey = (key: string) => {
  fireEvent.change(screen.getByLabelText('setup:cloudStep.keyLabel'), {
    target: { value: key },
  })
  fireEvent.click(
    screen.getByRole('button', { name: 'setup:cloudStep.saveKey' })
  )
}

describe('AddCloudProviderDialog — key check', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.providers.length = 0
    mocks.providers.push(openai())
    useProviderKeyStatusStore.setState({ statuses: {} })
    seedServiceHub({
      providers: {
        checkProviderEndpoint: mocks.checkProviderEndpoint,
        updateSettings: vi.fn().mockResolvedValue(undefined),
      } as never,
    })
  })

  it('keeps the dialog open with the reason when the provider refuses the key', async () => {
    mocks.checkProviderEndpoint.mockResolvedValue({
      ok: false,
      latencyMs: 70,
      modelCount: 0,
      httpStatus: 401,
      message:
        'Authentication failed: an API key is required or invalid for OpenAI.',
    })
    const { onKeySaved, onOpenChange } = renderOnOpenAi()

    saveKey('invalid-qa-test-key')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'setup:cloudStep.keyRejected Authentication failed: an API key is required or invalid for OpenAI.'
    )
    expect(mocks.updateProvider).not.toHaveBeenCalled()
    expect(onKeySaved).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('saves a key it could not check, saying so instead of "connected"', async () => {
    mocks.checkProviderEndpoint.mockResolvedValue({
      ok: false,
      latencyMs: 8000,
      modelCount: 0,
      message: 'Cannot connect to OpenAI at https://api.openai.com/v1.',
    })
    const { onKeySaved } = renderOnOpenAi()

    saveKey('sk-offline')

    await waitFor(() => expect(onKeySaved).toHaveBeenCalled())
    expect(mocks.updateProvider.mock.calls[0][1].api_key).toBe('sk-offline')
    expect(toast.warning).toHaveBeenCalledWith(
      'setup:cloudStep.savedUnverified',
      { description: 'Cannot connect to OpenAI at https://api.openai.com/v1.' }
    )
    expect(toast.success).not.toHaveBeenCalled()
    expect(
      keyStatusFor(
        { provider: 'openai', api_key: 'sk-offline' },
        useProviderKeyStatusStore.getState().statuses
      )?.state
    ).toBe('unverified')
  })
})
