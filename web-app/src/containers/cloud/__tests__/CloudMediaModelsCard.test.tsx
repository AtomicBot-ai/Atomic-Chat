import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CloudMediaModelsCard } from '../CloudMediaModelsCard'
import fixture from '@/lib/__tests__/media-catalog.fixture.json'
import type { MediaCatalogView } from '@/services/media/types'
import { useMediaCatalog } from '@/stores/media-catalog-store'
import { seedServiceHub } from '@/test/service-hub'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.count !== undefined ? `${key}:${options.count}` : key,
  }),
}))

const catalog = fixture as unknown as MediaCatalogView

const provider = (patch: Partial<ProviderObject> = {}): ProviderObject =>
  ({
    provider: 'openrouter',
    active: true,
    api_key: 'sk-test',
    base_url: 'https://openrouter.ai/api/v1',
    models: [],
    settings: [],
    ...patch,
  }) as unknown as ProviderObject

describe('CloudMediaModelsCard', () => {
  const listModels = vi.fn()

  beforeEach(() => {
    listModels.mockReset()
    useMediaCatalog.setState({ catalog, available: true, status: 'ready', listings: {}, listModels })
  })

  it('lists the enabled models of the open tab, with their workflows, and removes one', () => {
    const onChange = vi.fn()
    render(
      <CloudMediaModelsCard
        provider={provider({
          media: {
            models: [
              { id: 'openai/gpt-image-2.5-flare', kind: 'image' },
              { id: 'google/veo-3.1', kind: 'video' },
            ],
          },
        })}
        custom={false}
        onChange={onChange}
      />
    )

    expect(screen.getByRole('tab', { name: 'cloud:media.images:1' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'cloud:media.videos:1' })).toBeTruthy()
    expect(screen.getByText('openai/gpt-image-2.5-flare')).toBeTruthy()
    expect(screen.queryByText('google/veo-3.1')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'cloud:media.remove' }))
    expect(onChange).toHaveBeenCalledWith({ models: [{ id: 'google/veo-3.1', kind: 'video' }] })
  })

  it('switches to the video tab', () => {
    render(
      <CloudMediaModelsCard
        provider={provider({ media: { models: [{ id: 'google/veo-3.1', kind: 'video' }] } })}
        custom={false}
        onChange={() => {}}
      />
    )
    expect(screen.getByText('cloud:media.emptyImages')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'cloud:media.videos:1' }))
    expect(screen.getByText('google/veo-3.1')).toBeTruthy()
  })

  it('asks the provider for its live list on Reload and offers what it lists', async () => {
    const live = {
      id: 'black-forest-labs/flux-9',
      name: 'FLUX 9',
      kind: 'image',
      api: 'openrouter-images',
      workflows: ['create'],
      params: {},
      source: 'live',
    }
    seedServiceHub({
      media: {
        isSupported: () => true,
        catalog: async () => catalog,
        providerModels: async (name: string, kind: string) => ({
          provider: name,
          kind,
          api: 'openrouter-images',
          models: [live],
          live: true,
        }),
      } as never,
    })
    // The store's own listing, not the stub of the other tests.
    useMediaCatalog.setState({ listModels: useMediaCatalog.getInitialState().listModels })
    render(<CloudMediaModelsCard provider={provider()} custom={false} onChange={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'cloud:models.reload' }))
    await waitFor(() =>
      expect(useMediaCatalog.getState().listings['openrouter:image']).toMatchObject({
        status: 'ready',
        live: true,
        models: [live],
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'cloud:media.add' }))
    expect(await screen.findByText('FLUX 9')).toBeTruthy()
  })

  it('cannot reload a provider that is not connected yet', () => {
    render(
      <CloudMediaModelsCard
        provider={provider({ api_key: '' })}
        custom={false}
        onChange={() => {}}
      />
    )
    expect(
      (screen.getByRole('button', { name: 'cloud:models.reload' }) as HTMLButtonElement).disabled
    ).toBe(true)
  })

  it('shows a failed listing instead of the empty hint', () => {
    useMediaCatalog.setState({
      listings: {
        'openrouter:image': { status: 'error', models: [], live: false, error: 'Key rejected' },
      },
    })
    render(<CloudMediaModelsCard provider={provider()} custom={false} onChange={() => {}} />)
    expect(screen.getByRole('alert').textContent).toBe('Key rejected')
  })

  it('renders nothing for a catalog provider without media', () => {
    const { container } = render(
      <CloudMediaModelsCard provider={provider({ provider: 'anthropic' })} custom={false} onChange={() => {}} />
    )
    expect(container.firstChild).toBeNull()
  })

  it('asks a custom server which media API it speaks', () => {
    render(
      <CloudMediaModelsCard
        provider={provider({ provider: 'my-box', api_key: '', base_url: 'http://127.0.0.1:9000/v1' })}
        custom
        onChange={() => {}}
      />
    )
    expect(screen.getByText('cloud:media.pickApi')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'cloud:media.api.imageLabel' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'cloud:media.api.videoLabel' })).toBeTruthy()
  })
})
