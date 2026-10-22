import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'

import { CloudConnectionCard } from '../CloudConnectionCard'
import { noteProviderRequestError } from '@/lib/provider-key-check'
import {
  keyStatusFor,
  useProviderKeyStatusStore,
} from '@/stores/provider-key-status-store'

const { saveProviderApiKey } = vi.hoisted(() => ({
  saveProviderApiKey: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}))
vi.mock('@/containers/dialogs/DeleteProvider', () => ({
  default: () => <span />,
}))
// The real store fetches the catalogue on import.
vi.mock('@/stores/provider-registry-store', () => {
  const state = {
    status: 'idle',
    hasInitialized: true,
    providers: [{ provider: 'openai' }],
    error: null,
  }
  return {
    useProviderRegistryStore: Object.assign(
      (selector?: (s: unknown) => unknown) =>
        selector ? selector(state) : state,
      { getState: () => state }
    ),
    isKnownProvider: (name: string) => name === 'openai',
    ensureRegistryLoaded: async () => state.providers,
  }
})
vi.mock('@/lib/provider-api-key', async () => {
  const actual = await vi.importActual<typeof import('@/lib/provider-api-key')>(
    '@/lib/provider-api-key'
  )
  return { ...actual, saveProviderApiKey }
})

const openai = (patch: Partial<ProviderObject> = {}): ProviderObject =>
  ({
    provider: 'openai',
    active: true,
    api_key: '',
    base_url: 'https://api.openai.com/v1',
    models: [{ id: 'gpt-5.4' }],
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        controller_type: 'input',
        controller_props: { value: '', placeholder: 'sk-…' },
      },
    ],
    ...patch,
  }) as unknown as ProviderObject

const checkProviderEndpoint = vi.fn()
const serviceHub = {
  providers: () => ({
    checkProviderEndpoint,
    updateSettings: vi.fn().mockResolvedValue(undefined),
  }),
} as never

function renderCard(selected: ProviderObject) {
  return render(
    <CloudConnectionCard
      hideProviderSelect
      providers={[selected]}
      selected={selected}
      onSelect={() => {}}
      onDeleted={() => {}}
      updateProvider={() => {}}
      serviceHub={serviceHub}
    />
  )
}

const connect = (key: string) => {
  fireEvent.change(screen.getByPlaceholderText('sk-…'), {
    target: { value: key },
  })
  fireEvent.click(screen.getByText('cloud:connection.connect'))
}

const statusOf = (key: string) =>
  keyStatusFor(
    { provider: 'openai', api_key: key },
    useProviderKeyStatusStore.getState().statuses
  )

describe('CloudConnectionCard key check', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useProviderKeyStatusStore.setState({ statuses: {} })
  })

  it('refuses a key the provider rejects: the reason inline, nothing saved', async () => {
    checkProviderEndpoint.mockResolvedValue({
      ok: false,
      latencyMs: 90,
      modelCount: 0,
      httpStatus: 401,
      message:
        'Authentication failed: an API key is required or invalid for OpenAI.',
    })
    renderCard(openai())

    connect('invalid-qa-test-key')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'cloud:connection.keyRejected {"provider":"OpenAI"} Authentication failed: an API key is required or invalid for OpenAI.'
    )
    expect(checkProviderEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ api_key: 'invalid-qa-test-key' })
    )
    expect(saveProviderApiKey).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.getByText('cloud:connection.notConnected')).toBeVisible()
  })

  it('saves a refused key anyway when asked, as not verified', async () => {
    checkProviderEndpoint.mockResolvedValue({
      ok: false,
      latencyMs: 90,
      modelCount: 0,
      httpStatus: 401,
      message: 'Authentication failed',
      responseBody: '{"error":{"message":"Invalid API key"}}',
    })
    renderCard(openai())

    connect('sk-gateway')
    fireEvent.click(await screen.findByText('cloud:connection.saveAnyway'))

    await waitFor(() => expect(saveProviderApiKey).toHaveBeenCalled())
    expect(saveProviderApiKey.mock.calls[0][0].apiKey).toBe('sk-gateway')
    // Asked once: "Save anyway" does not ask again.
    expect(checkProviderEndpoint).toHaveBeenCalledTimes(1)
    expect(statusOf('sk-gateway')).toMatchObject({
      state: 'unverified',
      message:
        'cloud:connection.keyRejected {"provider":"OpenAI"} Authentication failed',
    })
    expect(toast.warning).toHaveBeenCalled()
  })

  it('saves a key without permission to list models, as not verified', async () => {
    checkProviderEndpoint.mockResolvedValue({
      ok: false,
      latencyMs: 90,
      modelCount: 0,
      httpStatus: 403,
      message: 'Access forbidden: check your API key permissions for OpenAI.',
      responseBody:
        '{"error":{"message":"You have insufficient permissions for this operation. Missing scopes: api.model.read."}}',
    })
    renderCard(openai())

    connect('sk-restricted')

    await waitFor(() => expect(saveProviderApiKey).toHaveBeenCalled())
    expect(screen.queryByRole('alert')).toBeNull()
    expect(statusOf('sk-restricted')).toMatchObject({
      state: 'unverified',
      message:
        'HTTP 403: You have insufficient permissions for this operation. Missing scopes: api.model.read.',
    })
  })

  it('connects a key the provider accepts', async () => {
    checkProviderEndpoint.mockResolvedValue({
      ok: true,
      latencyMs: 80,
      modelCount: 40,
    })
    renderCard(openai())

    connect('sk-live')

    await waitFor(() => expect(saveProviderApiKey).toHaveBeenCalled())
    expect(saveProviderApiKey.mock.calls[0][0].apiKey).toBe('sk-live')
    expect(toast.success).toHaveBeenCalledWith(
      'cloud:connection.saved {"provider":"OpenAI"}'
    )
    expect(statusOf('sk-live')).toBeUndefined()
  })

  it('saves a key it could not check, and says it is not verified', async () => {
    checkProviderEndpoint.mockResolvedValue({
      ok: false,
      latencyMs: 8000,
      modelCount: 0,
      message: 'Cannot connect to OpenAI at https://api.openai.com/v1.',
    })
    const { unmount } = renderCard(openai())

    connect('sk-offline')

    await waitFor(() => expect(saveProviderApiKey).toHaveBeenCalled())
    expect(toast.warning).toHaveBeenCalledWith(
      'cloud:connection.savedUnverified {"provider":"OpenAI"}',
      { description: 'Cannot connect to OpenAI at https://api.openai.com/v1.' }
    )
    expect(toast.success).not.toHaveBeenCalled()
    expect(statusOf('sk-offline')?.state).toBe('unverified')
    unmount()

    // The saved provider reads "configured, not verified", not "Connected".
    renderCard(openai({ api_key: 'sk-offline' }))
    expect(screen.getByText('cloud:connection.unverified')).toBeVisible()
    expect(screen.queryByText('cloud:connection.connected')).toBeNull()
    expect(screen.queryByTestId('cloud-connection-status-dot')).toBeNull()
    expect(screen.getByTestId('cloud-key-status')).toHaveTextContent(
      'Cannot connect to OpenAI at https://api.openai.com/v1.'
    )
  })

  it('stops calling a key connected once a chat was refused, until it checks out again', async () => {
    noteProviderRequestError(
      { provider: 'openai', api_key: 'invalid-qa-test-key' },
      Object.assign(new Error('Incorrect API key provided'), {
        statusCode: 401,
        responseBody:
          '{"error":{"message":"Incorrect API key provided: invalid-*******-key.","code":"invalid_api_key"}}',
      })
    )
    renderCard(openai({ api_key: 'invalid-qa-test-key' }))

    expect(screen.getByText('cloud:connection.rejected')).toBeVisible()
    expect(screen.queryByTestId('cloud-connection-status-dot')).toBeNull()

    checkProviderEndpoint.mockResolvedValue({
      ok: true,
      latencyMs: 80,
      modelCount: 40,
    })
    fireEvent.click(screen.getByText('cloud:connection.checkAgain'))

    expect(await screen.findByText('cloud:connection.connected')).toBeVisible()
    expect(screen.getByTestId('cloud-connection-status-dot')).toBeVisible()
    expect(statusOf('invalid-qa-test-key')).toBeUndefined()
  })
})
