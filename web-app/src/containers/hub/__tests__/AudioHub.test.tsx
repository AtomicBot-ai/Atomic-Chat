import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudioCatalogModel } from '@/services/audio-catalog-registry'
import type { AudioModelFile } from '@/services/audio/types'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: { children?: React.ReactNode }) => (
    <header>{children}</header>
  ),
}))

// Import has tests of its own and needs the service hub.
vi.mock('@/containers/hub/ImportLocalFile', () => ({
  ImportLocalFile: () => null,
}))

vi.mock('@/containers/hub/AudioModelDetailPanel', () => ({
  AudioModelDetailPanel: ({ model }: { model: AudioCatalogModel }) => (
    <aside data-testid="detail">{model.id}</aside>
  ),
}))

// The notice has tests of its own and reads the engine's state.
vi.mock('@/containers/audios/AudioEngineNotice', () => ({
  AudioEngineNotice: () => <p data-testid="audio-engine-notice" />,
}))

import { getBaselineAudioCatalog } from '@/services/audio-catalog-registry'
import { recommendedAudioQuant } from '@/services/audio-catalog-registry'
import { useAudioGenerationStore } from '@/stores/audio-generation-store'
import { AudioHub } from '../AudioHub'

const catalog = getBaselineAudioCatalog()
const bind = vi.fn(async () => {})

const fileOf = (id: string): AudioModelFile => {
  const quant = recommendedAudioQuant(
    catalog.models.find((model) => model.id === id)!
  )
  return { relativePath: quant.filename, bytes: quant.bytes } as AudioModelFile
}

function renderHub(props: Partial<React.ComponentProps<typeof AudioHub>> = {}) {
  const onSelectModel = vi.fn()
  const onQueryChange = vi.fn()
  render(
    <AudioHub
      query=""
      onQueryChange={onQueryChange}
      selectedModelId={null}
      onSelectModel={onSelectModel}
      {...props}
    />
  )
  return { onSelectModel, onQueryChange }
}

const rowNames = () =>
  screen
    .getAllByRole('button', { expanded: false })
    .concat(screen.queryAllByRole('button', { expanded: true }))
    .map((button) =>
      catalog.models.find((model) => button.textContent?.includes(model.name))
    )
    .filter(Boolean)
    .map((model) => model!.id)

describe('AudioHub', () => {
  beforeEach(() => {
    bind.mockClear()
    useAudioGenerationStore.setState({ catalog, modelFiles: [], bind })
  })

  it('lists every catalog model by mode, tagged with it, and binds the store', () => {
    renderHub()

    expect(bind).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('audio-engine-notice')).toBeInTheDocument()
    expect(
      screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    ).toEqual(['hub:available'])
    expect(rowNames()).toEqual([
      'qwen3-tts-1.7b-customvoice',
      'moss-tts-nano-100m',
      'ace-step-1.5-turbo',
      'stable-audio-3-small-sfx',
    ])
    expect(
      screen.getByTestId('audio-mode-ace-step-1.5-turbo')
    ).toHaveTextContent('audios:mode.music.title')
    expect(
      screen.getByTestId('audio-mode-stable-audio-3-small-sfx')
    ).toHaveTextContent('audios:mode.effects.title')
  })

  it('puts the models whose file is on disk, whole, under Downloaded', () => {
    const partial = { ...fileOf('qwen3-tts-1.7b-customvoice'), bytes: 1 }
    useAudioGenerationStore.setState({
      modelFiles: [fileOf('ace-step-1.5-turbo'), partial],
    })
    renderHub()

    expect(
      screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    ).toEqual(['hub:downloaded', 'hub:available'])
    expect(rowNames()[0]).toBe('ace-step-1.5-turbo')
    expect(screen.getAllByLabelText('hub:downloaded')).toHaveLength(1)
  })

  it('opens the model the URL names below its row, and closes it again', async () => {
    const { onSelectModel } = renderHub({
      selectedModelId: 'moss-tts-nano-100m',
    })

    expect(screen.getByTestId('detail')).toHaveTextContent('moss-tts-nano-100m')
    await userEvent.click(screen.getByRole('button', { expanded: true }))
    expect(onSelectModel).toHaveBeenLastCalledWith(null)

    await userEvent.click(
      screen.getByRole('button', { name: /ACE-Step 1.5 Turbo/ })
    )
    expect(onSelectModel).toHaveBeenLastCalledWith('ace-step-1.5-turbo')
  })

  it('narrows the list by the search', () => {
    renderHub({ query: 'stability' })
    expect(rowNames()).toEqual(['stable-audio-3-small-sfx'])
  })

  it('offers to clear a search that finds nothing', async () => {
    const { onQueryChange } = renderHub({ query: 'no such model' })

    expect(screen.getByText('hub:noModels')).toBeInTheDocument()
    // The no-results card's own button, after the search box's.
    const clear = screen.getAllByRole('button', { name: 'hub:clearSearch' })
    await userEvent.click(clear[clear.length - 1])
    expect(onQueryChange).toHaveBeenCalledWith('')
  })
})
