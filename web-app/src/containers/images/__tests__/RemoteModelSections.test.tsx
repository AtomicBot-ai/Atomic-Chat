import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RemoteModelSections } from '../RemoteModelSections'
import { route } from '@/constants/routes'
import { useImageSetting } from '@/hooks/useImageSetting'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useVideoSetting } from '@/hooks/useVideoSetting'
import fixture from '@/lib/__tests__/media-catalog.fixture.json'
import type { MediaCatalogView } from '@/services/media/types'
import { useMediaCatalog } from '@/stores/media-catalog-store'

const navigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const catalog = fixture as unknown as MediaCatalogView

const providers = [
  {
    provider: 'openai',
    active: true,
    api_key: 'sk-test',
    base_url: 'https://api.openai.com/v1',
    models: [],
    // A key-taking cloud: the badge reads Cloud, not Self-hosted.
    settings: [{ key: 'api-key' }],
    media: {
      models: [
        { id: 'gpt-image-2', kind: 'image' },
        { id: 'gpt-image-2.5-flare', kind: 'image' },
      ],
    },
  },
  {
    provider: 'openrouter',
    active: true,
    api_key: 'sk-test',
    base_url: 'https://openrouter.ai/api/v1',
    models: [],
    settings: [],
    media: { models: [{ id: 'google/veo-3.1', kind: 'video' }] },
  },
  // Enabled models, but no key: not offered.
  {
    provider: 'xai',
    active: true,
    api_key: '',
    base_url: 'https://api.x.ai/v1',
    models: [],
    settings: [],
    media: { models: [{ id: 'grok-imagine-image-2.0', kind: 'image' }] },
  },
] as unknown as ProviderObject[]

describe('RemoteModelSections', () => {
  beforeEach(() => {
    navigate.mockReset()
    useMediaCatalog.setState({ catalog, available: true, status: 'ready', listings: {} })
    useModelProvider.setState({ providers })
    useImageSetting.setState({ selectedRemote: null, selectedArtifactId: null })
    useVideoSetting.setState({ selectedRemote: null })
  })

  it("offers one section per connected provider with that kind's models", () => {
    render(<RemoteModelSections kind="image" />)
    const section = screen.getByTestId('remote-section-openai')
    expect(within(section).getByText('images:remote.cloud')).toBeTruthy()
    expect(within(section).getAllByRole('button')).toHaveLength(2)
    expect(screen.queryByTestId('remote-section-openrouter')).toBeNull()
    expect(screen.queryByTestId('remote-section-xai')).toBeNull()
  })

  it('picks a model for the page and closes the picker', () => {
    const onPicked = vi.fn()
    render(<RemoteModelSections kind="image" onPicked={onPicked} />)
    fireEvent.click(screen.getByTestId('remote-model-openai-gpt-image-2'))
    expect(useImageSetting.getState().selectedRemote).toEqual({
      provider: 'openai',
      model: 'gpt-image-2',
    })
    expect(onPicked).toHaveBeenCalled()
    expect(useVideoSetting.getState().selectedRemote).toBeNull()
  })

  it('marks the picked model', () => {
    useVideoSetting.setState({ selectedRemote: { provider: 'openrouter', model: 'google/veo-3.1' } })
    render(<RemoteModelSections kind="video" />)
    expect(
      screen.getByTestId('remote-model-openrouter-google/veo-3.1').getAttribute('aria-pressed')
    ).toBe('true')
  })

  it("offers only the models that can run the page's mode", () => {
    render(<RemoteModelSections kind="image" workflow="upscale" />)
    expect(screen.queryByTestId('remote-section-openai')).toBeNull()
  })

  it('leads to the Cloud page', () => {
    const onPicked = vi.fn()
    render(<RemoteModelSections kind="image" onPicked={onPicked} />)
    const link = screen.getByTestId('remote-models-connect')
    expect(link).toHaveTextContent('images:remote.connect')
    fireEvent.click(link)
    expect(navigate).toHaveBeenCalledWith({ to: route.cloud.index })
    expect(onPicked).toHaveBeenCalled()
  })

  it('shows nothing on a core without remote media', () => {
    useMediaCatalog.setState({ available: false, catalog: null })
    const { container } = render(<RemoteModelSections kind="image" />)
    expect(container.firstChild).toBeNull()
  })
})
