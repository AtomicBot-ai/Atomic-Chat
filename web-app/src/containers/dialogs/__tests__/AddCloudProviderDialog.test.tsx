import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AddCloudProviderDialog } from '../AddCloudProviderDialog'

const mockAddProvider = vi.fn()
const mockUpdateProvider = vi.fn()
const mockNavigate = vi.fn()

let storeProviders: any[] = []
let catalogProviders: any[] = []

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}))

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: () => ({
    providers: storeProviders,
    addProvider: mockAddProvider,
    updateProvider: mockUpdateProvider,
  }),
}))

vi.mock('@/stores/provider-registry-store', () => ({
  useProviderRegistryStore: (selector: (state: any) => unknown) =>
    selector({ providers: catalogProviders }),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.provider ? `${key}:${options.provider}` : key,
  }),
}))

vi.mock('@/containers/ProvidersAvatar', () => ({
  default: ({ provider }: { provider: { provider: string } }) => (
    <div data-testid={`provider-avatar-${provider.provider}`} />
  ),
}))

vi.mock('@/constants/routes', () => ({
  route: {
    settings: {
      providers: '/settings/providers/$providerName',
    },
  },
}))

const registryEntry = (provider: string, overrides: object = {}) => ({
  provider,
  active: true,
  api_key: '',
  base_url: `https://api.${provider}.com/v1`,
  models: [{ id: `${provider}-model` }],
  settings: [
    {
      key: 'api-key',
      title: 'API Key',
      controller_type: 'input',
      controller_props: { placeholder: 'Insert API Key', value: '' },
    },
  ],
  ...overrides,
})

const openCatalog = async () => {
  const user = userEvent.setup()
  render(
    <AddCloudProviderDialog onCreateCustomProvider={vi.fn()}>
      <button>open</button>
    </AddCloudProviderDialog>
  )
  await user.click(screen.getByText('open'))
  return user
}

describe('AddCloudProviderDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeProviders = []
    catalogProviders = [registryEntry('openai'), registryEntry('anthropic')]
  })

  it('lists catalog providers the user has not connected yet', async () => {
    storeProviders = [
      { provider: 'openai', active: true, api_key: 'sk-1', models: [] },
    ]

    await openCatalog()

    expect(
      screen.queryByTestId('provider-avatar-openai')
    ).not.toBeInTheDocument()
    expect(screen.getByTestId('provider-avatar-anthropic')).toBeInTheDocument()
  })

  it('marks entries that still hold a saved key', async () => {
    storeProviders = [
      { provider: 'anthropic', active: false, api_key: 'sk-ant', models: [] },
    ]

    await openCatalog()

    expect(screen.getByText('provider:keySaved')).toBeInTheDocument()
  })

  it('offers a custom OpenAI-compatible entry', async () => {
    const onCreateCustomProvider = vi.fn()
    const user = userEvent.setup()
    render(
      <AddCloudProviderDialog onCreateCustomProvider={onCreateCustomProvider}>
        <button>open</button>
      </AddCloudProviderDialog>
    )
    await user.click(screen.getByText('open'))
    await user.click(screen.getByText('provider:custom'))

    await user.type(screen.getByRole('textbox'), 'my-endpoint')
    await user.click(screen.getByText('common:create'))

    expect(onCreateCustomProvider.mock.calls).toEqual([['my-endpoint']])
    // Creating closes the whole flow rather than dropping back to the catalog.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByText('provider:custom')).not.toBeInTheDocument()
  })

  it('connects a provider by storing the key and activating it', async () => {
    storeProviders = [
      {
        provider: 'anthropic',
        active: false,
        api_key: '',
        base_url: 'https://api.anthropic.com/v1',
        models: [],
        settings: [
          {
            key: 'api-key',
            controller_type: 'input',
            controller_props: { placeholder: 'Insert API Key', value: '' },
          },
        ],
      },
    ]
    catalogProviders = [registryEntry('anthropic')]

    const user = await openCatalog()
    await user.click(screen.getByTestId('provider-avatar-anthropic'))

    const input = screen.getByLabelText('provider:apiKey')
    await user.type(input, 'sk-ant-new')
    await user.click(screen.getByText('provider:saveKey'))

    expect(mockUpdateProvider.mock.calls[0]).toEqual([
      'anthropic',
      {
        api_key: 'sk-ant-new',
        active: true,
        // The detail screen reads the key from the setting, so it has to be
        // written alongside the top-level field.
        settings: [
          expect.objectContaining({
            key: 'api-key',
            controller_props: expect.objectContaining({ value: 'sk-ant-new' }),
          }),
        ],
      },
    ])
    expect(mockNavigate.mock.calls[0]).toEqual([
      {
        to: '/settings/providers/$providerName',
        params: { providerName: 'anthropic' },
      },
    ])
    expect(screen.queryByText('provider:saveKey')).not.toBeInTheDocument()
  })

  it('adds a catalog-only provider that is not in the store yet', async () => {
    storeProviders = []
    catalogProviders = [registryEntry('anthropic')]

    const user = await openCatalog()
    await user.click(screen.getByTestId('provider-avatar-anthropic'))
    await user.type(screen.getByLabelText('provider:apiKey'), 'sk-ant-new')
    await user.click(screen.getByText('provider:saveKey'))

    expect(mockAddProvider.mock.calls[0][0]).toMatchObject({
      provider: 'anthropic',
      api_key: 'sk-ant-new',
      active: true,
      base_url: 'https://api.anthropic.com/v1',
    })
    expect(mockUpdateProvider.mock.calls).toEqual([])
  })
})
