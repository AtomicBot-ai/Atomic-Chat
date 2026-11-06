import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudioModelState } from '@/hooks/useAudioModel'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  state: {} as Partial<AudioModelState>,
  download: vi.fn(async () => {}),
  cancelDownload: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}))

vi.mock('@/hooks/useAudioModel', () => ({
  useAudioModel: (model: { quants: AudioModelState['quant'][] }) => ({
    quant: model.quants[0],
    installed: false,
    downloading: false,
    progress: 0,
    download: mocks.download,
    cancelDownload: mocks.cancelDownload,
    remove: mocks.remove,
    ...mocks.state,
  }),
}))

import { route } from '@/constants/routes'
import {
  findAudioModel,
  getBaselineAudioCatalog,
} from '@/services/audio-catalog-registry'
import type { AudioStatus } from '@/services/audio/types'
import { useAudioGenerationStore } from '@/stores/audio-generation-store'
import { AudioModelDetailPanel } from '../AudioModelDetailPanel'

const catalog = getBaselineAudioCatalog()
const sfx = findAudioModel(catalog, 'stable-audio-3-small-sfx')!
const moss = findAudioModel(catalog, 'moss-tts-nano-100m')!

const engineReady = () =>
  useAudioGenerationStore.setState({
    core: 'ready',
    status: { install: { state: 'installed' } } as AudioStatus,
    hostBackendId: 'macos-arm64',
    hostBackendResolved: true,
  })

const actions = () => screen.getByTestId('audio-quant-actions')

describe('AudioModelDetailPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state = {}
    useAudioGenerationStore.getState().reset()
    useAudioGenerationStore.setState({ catalog })
  })

  it('tells what the model makes, its file, license, clip length and notice', () => {
    engineReady()
    render(<AudioModelDetailPanel model={sfx} />)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Stable Audio 3 Small SFX'
    )
    expect(screen.getByText('Stability AI')).toBeInTheDocument()
    expect(screen.getByTestId('audio-attribution')).toHaveTextContent(
      'Powered by Stability AI'
    )
    expect(screen.getByTestId(`audio-quant-${sfx.id}`)).toHaveTextContent('Q8')
    expect(screen.getByText('audios:mode.effects.title')).toBeInTheDocument()
    expect(
      screen.getByText('Stability AI Community License')
    ).toBeInTheDocument()
    expect(
      screen.getByText('hub:audioLengthRange {"min":1,"max":30}')
    ).toBeInTheDocument()
    expect(screen.getByRole('link')).toHaveAttribute(
      'href',
      `https://huggingface.co/${sfx.repo}`
    )
  })

  it('downloads the model and makes it the one its mode opens on', async () => {
    engineReady()
    render(<AudioModelDetailPanel model={moss} />)

    await userEvent.click(
      screen.getByRole('button', {
        name: 'audios:model.download {"name":"MOSS-TTS-Nano 100M"}',
      })
    )

    expect(mocks.download).toHaveBeenCalledTimes(1)
    expect(useAudioGenerationStore.getState().forms.speech.modelId).toBe(
      moss.id
    )
    expect(screen.queryByText('audios:model.unavailable')).toBeNull()
  })

  it('holds Download, and says why, where the engine cannot run', () => {
    useAudioGenerationStore.setState({
      core: 'ready',
      hostBackendId: null,
      hostBackendResolved: true,
    })
    render(<AudioModelDetailPanel model={moss} />)

    expect(
      screen.getByRole('button', {
        name: 'audios:model.download {"name":"MOSS-TTS-Nano 100M"}',
      })
    ).toBeDisabled()
    expect(screen.getByText('audios:model.unavailable')).toBeInTheDocument()
  })

  it('says nothing while the core has not answered yet', () => {
    render(<AudioModelDetailPanel model={moss} />)

    expect(screen.queryByText('audios:model.unavailable')).toBeNull()
  })

  it('shows the progress in the action slot and cancels from it', async () => {
    engineReady()
    mocks.state = { downloading: true, progress: 0.42 }
    render(<AudioModelDetailPanel model={moss} />)

    expect(actions()).toHaveTextContent('42%')
    await userEvent.click(
      screen.getByRole('button', { name: 'common:cancelDownload' })
    )
    expect(mocks.cancelDownload).toHaveBeenCalledTimes(1)
  })

  it('opens a model on disk in the Audios studio, on its mode', async () => {
    engineReady()
    mocks.state = { installed: true }
    render(<AudioModelDetailPanel model={sfx} />)

    await userEvent.click(
      screen.getByRole('button', { name: 'hub:openInAudios' })
    )

    const store = useAudioGenerationStore.getState()
    expect(store.mode).toBe('effects')
    expect(store.forms.effects.modelId).toBe(sfx.id)
    expect(mocks.navigate).toHaveBeenCalledWith({ to: route.audios.index })
  })

  it('removes a model on disk after asking', async () => {
    engineReady()
    mocks.state = { installed: true }
    render(<AudioModelDetailPanel model={sfx} />)

    await userEvent.click(
      screen.getByRole('button', {
        name: 'audios:model.remove {"name":"Stable Audio 3 Small SFX"}',
      })
    )
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'audios:model.removeTitle {"name":"Stable Audio 3 Small SFX"}'
    )
    expect(mocks.remove).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('audio-model-remove-confirm'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(mocks.remove).toHaveBeenCalledTimes(1)
  })
})
