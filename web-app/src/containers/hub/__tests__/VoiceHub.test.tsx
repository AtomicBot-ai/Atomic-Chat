import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { VOICE_MODEL_HF_REPO, VOICE_MODEL_ID } from '@/constants/voice'

const voice = vi.hoisted(() => ({ installed: false }))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
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

vi.mock('@/hooks/useVoiceModel', () => ({
  useVoiceModel: () => ({ installed: voice.installed }),
}))

// The download, progress and removal are the voice settings' own card.
vi.mock('@/containers/VoiceModelCard', () => ({
  default: ({ variant }: { variant: string }) => (
    <div data-testid="voice-model-card">{variant}</div>
  ),
}))

import { VoiceHub } from '../VoiceHub'

function renderHub(props: Partial<React.ComponentProps<typeof VoiceHub>> = {}) {
  const onSelectModel = vi.fn()
  const onQueryChange = vi.fn()
  render(
    <VoiceHub
      query=""
      onQueryChange={onQueryChange}
      selectedModelId={null}
      onSelectModel={onSelectModel}
      {...props}
    />
  )
  return { onSelectModel, onQueryChange }
}

describe('VoiceHub', () => {
  beforeEach(() => {
    voice.installed = false
  })

  it('lists the voice model closed, and opens it from its row', async () => {
    const { onSelectModel } = renderHub()

    const row = screen.getByRole('button', { name: /Voxtral Mini 3B/ })
    expect(row).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('hub:voiceModels')).toBeInTheDocument()
    expect(screen.queryByTestId('voice-model-card')).not.toBeInTheDocument()

    await userEvent.click(row)
    expect(onSelectModel).toHaveBeenCalledWith(VOICE_MODEL_ID)
  })

  it('offers the settings card and the source when open, and closes again', async () => {
    const { onSelectModel } = renderHub({ selectedModelId: VOICE_MODEL_ID })

    expect(screen.getByTestId('voice-model-card')).toHaveTextContent('settings')
    expect(
      screen.getByRole('link', { name: /hub:source.huggingFace/ })
    ).toHaveAttribute('href', `https://huggingface.co/${VOICE_MODEL_HF_REPO}`)

    await userEvent.click(
      screen.getByRole('button', { name: /Voxtral Mini 3B/, expanded: true })
    )
    expect(onSelectModel).toHaveBeenCalledWith(null)
  })

  it('marks the model downloaded', () => {
    voice.installed = true
    renderHub()

    expect(screen.getByLabelText('hub:downloaded')).toBeInTheDocument()
  })

  it('finds the model by every word of a search', () => {
    renderHub({ query: 'voxtral speech' })
    expect(
      screen.getByRole('button', { name: /Voxtral Mini 3B/ })
    ).toBeInTheDocument()
  })

  it('says nothing matched, and clears the search', async () => {
    const { onQueryChange } = renderHub({ query: 'whisper' })

    expect(screen.getByText('hub:noVoiceModels')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /Voxtral Mini 3B/ })
    ).not.toBeInTheDocument()
    const clears = screen.getAllByRole('button', { name: 'hub:clearSearch' })
    await userEvent.click(clears[clears.length - 1])
    expect(onQueryChange).toHaveBeenCalledWith('')
  })
})
