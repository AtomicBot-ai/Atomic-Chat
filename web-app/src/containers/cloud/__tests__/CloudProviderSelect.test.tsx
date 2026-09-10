import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { CloudProviderSelect } from '../CloudProviderSelect'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

// The grouping asks the registry store what the catalogue ships; anything
// absent from this list is a provider the user added themselves.
vi.mock('@/stores/provider-registry-store', () => ({
  useProviderRegistryStore: {
    getState: () => ({
      hasInitialized: true,
      providers: [
        { provider: 'openai' },
        { provider: 'anthropic' },
        { provider: 'ollama' },
      ],
    }),
  },
  isKnownProvider: (name: string) =>
    ['openai', 'anthropic', 'ollama'].includes(name),
}))

vi.mock('@/containers/ProvidersAvatar', () => ({
  default: ({ provider }: { provider: { provider: string } }) => (
    <span data-testid={`avatar-${provider.provider}`} />
  ),
}))

vi.mock('@/lib/utils', async () => {
  const actual = await vi.importActual<typeof import('@/lib/utils')>(
    '@/lib/utils'
  )
  return { ...actual, getProviderTitle: (name: string) => name }
})

const apiKeySetting: ProviderSetting = {
  key: 'api-key',
  title: 'API Key',
  description: '',
  controller_type: 'input',
  controller_props: { value: '', type: 'password' },
}

const providers: ProviderObject[] = [
  { provider: 'llamacpp-upstream', active: true, models: [], settings: [], persist: true },
  { provider: 'mlx', active: true, models: [], settings: [], persist: true },
  {
    provider: 'openai',
    active: true,
    models: [],
    settings: [apiKeySetting],
    base_url: 'https://api.openai.com/v1',
    api_key: 'sk-live',
  },
  {
    provider: 'anthropic',
    active: true,
    models: [],
    settings: [apiKeySetting],
    base_url: 'https://api.anthropic.com/v1',
  },
  {
    provider: 'ollama',
    active: true,
    models: [],
    settings: [],
    base_url: 'http://localhost:11434/v1',
  },
]

const renderSelect = async (
  overrides: Partial<Parameters<typeof CloudProviderSelect>[0]> = {}
) => {
  const onSelect = vi.fn()
  const onAddCustom = vi.fn()
  const user = userEvent.setup()
  render(
    <CloudProviderSelect
      providers={providers}
      selected={undefined}
      onSelect={onSelect}
      onAddCustom={onAddCustom}
      {...overrides}
    />
  )
  // Radix opens on pointerdown, which fireEvent.click does not produce.
  await user.click(screen.getByRole('button'))
  return { onSelect, onAddCustom, user }
}

describe('CloudProviderSelect', () => {
  it('lists ollama under self-hosted rather than dropping it', async () => {
    await renderSelect()

    // The orphan trap: Ollama is a remote-transport provider on a loopback
    // URL, so a name-only "is it local" filter would leave it in no UI at all.
    expect(screen.getByTestId('avatar-ollama')).toBeInTheDocument()
    expect(screen.getByText('cloud:connection.groupSelfHosted')).toBeInTheDocument()
  })

  it('lists key-taking clouds under the hosted group', async () => {
    await renderSelect()

    expect(screen.getByTestId('avatar-openai')).toBeInTheDocument()
    expect(screen.getByTestId('avatar-anthropic')).toBeInTheDocument()
    expect(screen.getByText('cloud:connection.groupHosted')).toBeInTheDocument()
  })

  it('omits local engines', async () => {
    await renderSelect()

    expect(screen.queryByTestId('avatar-llamacpp-upstream')).not.toBeInTheDocument()
    expect(screen.queryByTestId('avatar-mlx')).not.toBeInTheDocument()
  })

  it('marks only connected providers with a dot', async () => {
    await renderSelect()

    expect(screen.getByTestId('cloud-connected-dot-openai')).toBeInTheDocument()
    expect(
      screen.queryByTestId('cloud-connected-dot-anthropic')
    ).not.toBeInTheDocument()
  })

  it('leaves a self-hosted endpoint undotted until it has answered', async () => {
    // Ollama needs no key, which is not the same as the user having set it up:
    // an empty model list means nothing has ever replied on that port.
    await renderSelect()

    expect(
      screen.queryByTestId('cloud-connected-dot-ollama')
    ).not.toBeInTheDocument()
  })

  it('dots a self-hosted endpoint once it has served a model list', async () => {
    await renderSelect({
      providers: providers.map((provider) =>
        provider.provider === 'ollama'
          ? { ...provider, models: [{ id: 'llama3' } as Model] }
          : provider
      ),
    })

    expect(screen.getByTestId('cloud-connected-dot-ollama')).toBeInTheDocument()
  })

  it('reports the picked provider', async () => {
    const { onSelect, user } = await renderSelect()

    await user.click(screen.getByText('anthropic'))

    expect(onSelect.mock.calls).toHaveLength(1)
    expect(onSelect.mock.calls[0][0]).toBe('anthropic')
  })

  it('lists a user-added provider with self-hosted, not below the clouds', async () => {
    // It looks like a cloud from its fields alone — https URL, api-key
    // setting — so only its absence from the catalogue puts it up top, beside
    // the "+" that created it.
    await renderSelect({
      providers: [
        ...providers,
        {
          provider: 'my-endpoint',
          active: true,
          models: [],
          settings: [apiKeySetting],
          base_url: 'https://api.openai.com/v1',
        },
      ],
    })

    const labels = screen.getAllByText(/^(my-endpoint|cloud:connection\.group)/)
    const order = labels.map((node) => node.textContent)
    expect(order.indexOf('my-endpoint')).toBeLessThan(
      order.indexOf('cloud:connection.groupHosted')
    )
  })

  it('offers a custom OpenAI-compatible entry', async () => {
    const { onAddCustom, user } = await renderSelect()

    await user.click(screen.getByText('cloud:connection.custom'))

    expect(onAddCustom.mock.calls).toHaveLength(1)
  })
})
