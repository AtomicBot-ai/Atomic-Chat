import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}))

import { AUDIO_DEFAULTS, AUDIO_MODELS } from '@/lib/audio/models'

import { AudioGenerationPage } from '../AudioGenerationPage'

const user = userEvent.setup()

const prompt = () =>
  screen.getByRole('textbox', { name: /audios:form\.(text|prompt)$/ })
const modeTo = async (mode: string) => {
  await user.click(screen.getByTestId('audio-workflow-select'))
  await user.click(screen.getByTestId(`audio-workflow-option-${mode}`))
}

describe('Audios', () => {
  it('opens on text to speech with the studio heading and its first model', () => {
    render(<AudioGenerationPage />)

    expect(
      screen.getByRole('heading', { name: 'audios:page.title' })
    ).toBeInTheDocument()
    expect(screen.getByTestId('audio-models-toggle')).toHaveTextContent(
      AUDIO_MODELS.speech[0].name
    )
    expect(prompt()).toHaveValue(AUDIO_DEFAULTS.speech.prompt)
    expect(screen.getByText('audios:form.speed')).toBeInTheDocument()
    expect(screen.queryByText('audios:form.duration')).not.toBeInTheDocument()
  })

  it('keeps Generate off, saying the audio engine is not here yet', () => {
    render(<AudioGenerationPage />)

    expect(screen.getByTestId('image-generate')).toBeDisabled()
    expect(screen.getByTestId('image-empty-state')).toHaveAttribute(
      'data-modality',
      'audio'
    )
    expect(screen.getByText('audios:gallery.emptyNoModel')).toBeInTheDocument()
  })

  it('lists the mode’s models from the empty pane, none of them downloadable yet', async () => {
    render(<AudioGenerationPage />)

    await user.click(screen.getByTestId('image-empty-download'))

    const list = screen.getByTestId('audio-models-list')
    for (const model of AUDIO_MODELS.speech) {
      expect(
        within(list).getByRole('button', {
          name: `audios:model.download:${JSON.stringify({ name: model.name })}`,
        })
      ).toBeDisabled()
    }
    expect(list).toHaveTextContent('audios:model.comingSoon')
  })

  it('gives music its own settings and prompt, and keeps speech’s for coming back', async () => {
    render(<AudioGenerationPage />)
    await user.clear(prompt())
    await user.type(prompt(), 'Hello there')

    await modeTo('music')

    expect(prompt()).toHaveValue(AUDIO_DEFAULTS.music.prompt)
    expect(screen.getByTestId('audio-models-toggle')).toHaveTextContent(
      AUDIO_MODELS.music[0].name
    )
    expect(screen.getByText('audios:form.tempo')).toBeInTheDocument()
    expect(screen.getByLabelText('audios:form.loop')).toBeInTheDocument()
    expect(screen.queryByText('audios:form.speed')).not.toBeInTheDocument()

    await modeTo('speech')
    expect(prompt()).toHaveValue('Hello there')
  })

  it('resets a mode’s settings but keeps its prompt', async () => {
    render(<AudioGenerationPage />)
    await modeTo('effects')
    await user.click(screen.getByLabelText('audios:form.loop'))
    await user.clear(prompt())
    await user.type(prompt(), 'Rain on a tin roof')
    expect(screen.getByLabelText('audios:form.loop')).toBeChecked()

    await user.click(screen.getByTestId('audio-reset'))

    expect(screen.getByLabelText('audios:form.loop')).not.toBeChecked()
    expect(prompt()).toHaveValue('Rain on a tin roof')
    // Effects have no tempo.
    expect(screen.queryByText('audios:form.tempo')).not.toBeInTheDocument()
  })
})
