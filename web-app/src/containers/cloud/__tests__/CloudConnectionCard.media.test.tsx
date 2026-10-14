import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CloudConnectionCard } from '../CloudConnectionCard'
import fixture from '@/lib/__tests__/media-catalog.fixture.json'
import type {
  MediaCatalogView,
  MediaProviderModels,
} from '@/services/media/types'
import { useMediaCatalog } from '@/stores/media-catalog-store'
import { seedServiceHub } from '@/test/service-hub'

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/containers/dialogs/DeleteProvider', () => ({
  default: () => <span />,
}))
// The registration itself is the Rust proxy's; here it only has to have happened first.
const registered = vi.hoisted(() => [] as string[])
vi.mock('@/utils/registerRemoteProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/registerRemoteProvider')>()),
  registerRemoteProvider: vi.fn(
    async (provider: { provider: string; base_url?: string }) => {
      registered.push(`${provider.provider} ${provider.base_url}`)
      return true
    }
  ),
}))

const sdcpp = (patch: Partial<ProviderObject> = {}): ProviderObject =>
  ({
    provider: 'sdcpp-server',
    active: true,
    api_key: '',
    base_url: 'http://127.0.0.1:1234',
    media_only: true,
    models: [],
    settings: [
      {
        key: 'base-url',
        title: 'Base URL',
        controller_type: 'input',
        controller_props: { value: 'http://127.0.0.1:1234' },
      },
    ],
    ...patch,
  }) as unknown as ProviderObject

const answer = (patch: Partial<MediaProviderModels>): MediaProviderModels => ({
  provider: 'sdcpp-server',
  kind: 'image',
  api: 'a1111',
  models: [],
  live: true,
  ...patch,
})

function renderCard(selected: ProviderObject) {
  const updateProvider = vi.fn()
  render(
    <CloudConnectionCard
      providers={[selected]}
      selected={selected}
      onSelect={() => {}}
      onAddCustom={() => {}}
      onDeleted={() => {}}
      updateProvider={updateProvider}
      serviceHub={{ providers: () => ({}) } as never}
    />
  )
  return updateProvider
}

describe('CloudConnectionCard for a media server', () => {
  let listing: MediaProviderModels

  beforeEach(() => {
    registered.length = 0
    toasts.success.mockReset()
    toasts.error.mockReset()
    listing = answer({})
    seedServiceHub({
      media: {
        isSupported: () => true,
        catalog: async () => fixture as unknown as MediaCatalogView,
        providerModels: async () => listing,
      } as never,
    })
    useMediaCatalog.setState({
      catalog: fixture as unknown as MediaCatalogView,
      available: true,
      status: 'ready',
      listings: {},
      listModels: useMediaCatalog.getInitialState().listModels,
    })
  })

  it('connects from its address: registers it, then enables every model the server lists', async () => {
    listing = answer({
      models: [
        {
          id: 'flux1-schnell-q4_k.gguf',
          name: 'flux1-schnell-q4_k',
          kind: 'image',
          api: 'a1111',
          workflows: ['create'],
          params: {},
          source: 'live',
        },
      ],
    })
    const updateProvider = renderCard(sdcpp())
    const button = screen.getByTestId('cloud-media-server-connect')
    expect(button).toHaveTextContent('cloud:connection.connect')
    fireEvent.click(button)

    await waitFor(() => expect(updateProvider).toHaveBeenCalledTimes(1))
    const [[name, data]] = updateProvider.mock.calls as [
      [string, Partial<ProviderObject>],
    ]
    expect(name).toBe('sdcpp-server')
    expect(data.media?.models).toEqual([
      {
        id: 'flux1-schnell-q4_k.gguf',
        kind: 'image',
        name: 'flux1-schnell-q4_k',
      },
    ])
    expect(registered).toEqual(['sdcpp-server http://127.0.0.1:1234'])
  })

  it('says why when the server does not answer, and enables nothing', async () => {
    listing = answer({
      live: false,
      error: { code: 'REMOTE_UNAVAILABLE', message: 'connect ECONNREFUSED' },
    })
    const updateProvider = renderCard(sdcpp())
    fireEvent.click(screen.getByTestId('cloud-media-server-connect'))

    await waitFor(() => expect(toasts.error).toHaveBeenCalledTimes(1))
    expect(toasts.error.mock.calls[0]).toEqual([
      'cloud:connection.mediaFailed',
      { description: 'connect ECONNREFUSED' },
    ])
    expect(updateProvider).not.toHaveBeenCalled()
    expect(screen.getByTestId('cloud-media-server-connect')).not.toBeDisabled()
  })

  it('says so when the server lists no model', async () => {
    renderCard(sdcpp())
    fireEvent.click(screen.getByTestId('cloud-media-server-connect'))
    await waitFor(() => expect(toasts.error).toHaveBeenCalledTimes(1))
    expect(toasts.error.mock.calls[0]?.[0]).toBe(
      'cloud:connection.mediaNoModels'
    )
  })

  it('reloads once connected', () => {
    renderCard(sdcpp({ media: { models: [{ id: 'm', kind: 'image' }] } }))
    expect(screen.getByText('cloud:connection.connected')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-media-server-connect')).toHaveTextContent(
      'cloud:models.reload'
    )
  })

  it('leaves a provider with chat models to its key and its models card', () => {
    renderCard(
      sdcpp({
        provider: 'llamacpp-server',
        media_only: undefined,
        base_url: 'http://127.0.0.1:8080/v1',
      })
    )
    expect(screen.queryByTestId('cloud-media-server-connect')).toBeNull()
  })
})
