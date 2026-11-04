import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
  i18n: { t: (key: string) => key },
}))
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  convertFileSrc: (path: string) => `asset://${path}`,
}))
const registry = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('@/services/audio-catalog-registry', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/services/audio-catalog-registry')
  >()),
  fetchAudioCatalog: registry.fetch,
}))
const toast = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
const transfer = vi.hoisted(() => ({
  transferFiles: vi.fn(async () => {}),
  cancelTransfer: vi.fn(async () => {}),
}))
vi.mock('@/services/diffusion/transfer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/diffusion/transfer')>()),
  transferFiles: transfer.transferFiles,
  cancelTransfer: transfer.cancelTransfer,
}))

import { useDownloadStore } from '@/hooks/useDownloadStore'
import {
  ACE,
  MOSS,
  QWEN,
  QWEN_WIRE,
  SFX,
  SFX_WIRE,
  catalog,
  makeEngineCatalog,
  makeFakeAudio,
  makeFile,
  makeItem,
  makeJob,
  makeLoadedStatus,
  makeStatus,
  missingRoute,
  type FakeAudio,
} from '@/lib/audio/__tests__/audio-fixtures'
import { audioDownloadTaskId } from '@/lib/audio/models'
import { useAudioGenerationStore } from '@/stores/audio-generation-store'
import { seedServiceHub } from '@/test/service-hub'
import { TooltipProvider } from '@/components/ui/tooltip'

import { AudioGenerationPage } from '../AudioGenerationPage'

const user = userEvent.setup()

const prompt = () =>
  screen.getByRole('textbox', { name: /audios:form\.(text|prompt)$/ })
const modeTo = async (mode: string) => {
  await user.click(screen.getByTestId('audio-workflow-select'))
  await user.click(screen.getByTestId(`audio-workflow-option-${mode}`))
}
const openModels = () => user.click(screen.getByTestId('audio-models-toggle'))

describe('Audios', () => {
  let fake: FakeAudio

  const open = async () => {
    render(
      <TooltipProvider>
        <AudioGenerationPage />
      </TooltipProvider>
    )
    await waitFor(() =>
      expect(useAudioGenerationStore.getState().core).not.toBe('checking')
    )
    await waitFor(() =>
      expect(fake.getStatus.mock.calls.length).toBeGreaterThan(0)
    )
  }

  const ready = async (...modelIds: string[]) => {
    fake.listModelFiles.mockResolvedValue(modelIds.map((id) => makeFile(id)))
    await open()
    await waitFor(() =>
      expect(useAudioGenerationStore.getState().hostBackendResolved).toBe(true)
    )
  }

  beforeEach(() => {
    toast.error.mockClear()
    transfer.transferFiles.mockReset()
    transfer.cancelTransfer.mockReset()
    registry.fetch.mockReset()
    registry.fetch.mockResolvedValue({
      catalog: catalog(),
      source: 'baseline',
      fetchedAt: null,
    })
    fake = makeFakeAudio()
    seedServiceHub({ audio: fake })
    useAudioGenerationStore.getState().reset()
    useDownloadStore.setState({ downloads: {} })
  })

  describe('what the catalog says a model takes', () => {
    it('opens on text to speech with the catalog’s first model and its fields', async () => {
      await ready()

      expect(
        screen.getByRole('heading', { name: 'audios:page.title' })
      ).toBeInTheDocument()
      expect(screen.getByTestId('audio-models-toggle')).toHaveTextContent(
        'Qwen3-TTS 1.7B'
      )
      expect(screen.getByLabelText('audios:form.voice')).toBeInTheDocument()
      expect(screen.getByLabelText('audios:form.instruct')).toBeInTheDocument()
      expect(screen.getByLabelText('images:form.seed')).toHaveValue('42')
    })

    it('shows no field the engine has no parameter for', async () => {
      await ready()

      for (const gone of ['speed', 'pitch', 'sampleRate']) {
        expect(
          screen.queryByText(`audios:form.${gone}`)
        ).not.toBeInTheDocument()
      }
    })

    it('gives MOSS only a seed', async () => {
      await ready()
      await openModels()
      await user.click(
        within(screen.getByTestId(`audio-model-${MOSS}`)).getByRole('button', {
          pressed: false,
        })
      )

      expect(
        screen.queryByLabelText('audios:form.voice')
      ).not.toBeInTheDocument()
      expect(
        screen.queryByLabelText('audios:form.instruct')
      ).not.toBeInTheDocument()
      expect(screen.getByLabelText('images:form.seed')).toBeInTheDocument()
    })

    it('gives music its lyrics, duration and tempo, tempo left to the model', async () => {
      await ready()
      await modeTo('music')

      expect(screen.getByTestId('audio-models-toggle')).toHaveTextContent(
        'ACE-Step 1.5 Turbo'
      )
      expect(screen.getByLabelText('audios:form.lyrics')).toBeInTheDocument()
      expect(screen.getByLabelText('audios:form.tempo')).toHaveValue('')
      expect(screen.getByRole('spinbutton')).toHaveValue(10)
      expect(screen.getByRole('spinbutton')).toHaveAttribute('max', '60')
      expect(screen.getByLabelText('audios:form.loop')).toBeInTheDocument()
    })

    it('keeps the tempo to digits', async () => {
      await ready()
      await modeTo('music')

      await user.type(screen.getByLabelText('audios:form.tempo'), '1a2b0')

      expect(screen.getByLabelText('audios:form.tempo')).toHaveValue('120')
    })

    it('keeps each mode’s text for coming back', async () => {
      await ready()
      await user.clear(prompt())
      await user.type(prompt(), 'Hello there')

      await modeTo('music')
      expect(prompt()).not.toHaveValue('Hello there')

      await modeTo('speech')
      expect(prompt()).toHaveValue('Hello there')
    })

    it('resets a mode’s settings but keeps its prompt', async () => {
      await ready()
      await modeTo('effects')
      await user.click(screen.getByLabelText('audios:form.loop'))
      await user.clear(prompt())
      await user.type(prompt(), 'Rain on a tin roof')

      await user.click(screen.getByTestId('audio-reset'))

      expect(screen.getByLabelText('audios:form.loop')).not.toBeChecked()
      expect(prompt()).toHaveValue('Rain on a tin roof')
    })

    it('fills the voices in once the model runs', async () => {
      fake.getStatus.mockResolvedValue(makeLoadedStatus())
      await ready(QWEN)
      await waitFor(() =>
        expect(useAudioGenerationStore.getState().capabilities).not.toBeNull()
      )

      await user.click(screen.getByLabelText('audios:form.voice'))

      expect(
        await screen.findByRole('menuitem', { name: 'Uncle Fu' })
      ).toBeInTheDocument()
    })

    it('hides the voices of a running model that has none', async () => {
      fake.getStatus.mockResolvedValue(makeLoadedStatus())
      fake.getCapabilities.mockResolvedValue({
        modelId: QWEN_WIRE,
        mode: 'speech',
        family: 'qwen3_tts',
        task: 'tts',
        params: [],
        voices: [],
        supportsVoiceRef: false,
        requiresVoiceRef: false,
      })
      await ready(QWEN)

      await waitFor(() =>
        expect(
          screen.queryByLabelText('audios:form.voice')
        ).not.toBeInTheDocument()
      )
    })
  })

  describe('on a core without audio', () => {
    beforeEach(() => {
      fake.getStatus.mockRejectedValue(missingRoute())
    })

    it('says the app needs a newer core, quietly', async () => {
      await open()

      expect(screen.getByTestId('audio-engine-notice')).toHaveTextContent(
        'audios:engine.coreTooOld.title'
      )
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(toast.error).not.toHaveBeenCalled()
    })

    it('can start nothing, and still lists the models', async () => {
      await open()

      expect(screen.getByTestId('image-generate')).toBeDisabled()
      expect(
        screen.queryByTestId('image-empty-download')
      ).not.toBeInTheDocument()
      await openModels()
      expect(
        screen.getByRole('button', {
          name: `audios:model.download:${JSON.stringify({ name: 'Qwen3-TTS 1.7B' })}`,
        })
      ).toBeDisabled()
      expect(screen.getByTestId('audio-models-list')).toHaveTextContent(
        'audios:model.unavailable'
      )
    })
  })

  describe('the engine', () => {
    it('offers to install it, with the size the core reports', async () => {
      fake.getStatus.mockResolvedValue(
        makeStatus({ install: { state: 'not-installed' } })
      )
      await ready()

      expect(screen.getByTestId('audio-engine-install')).toHaveTextContent(
        'audios:engine.install.actionSize'
      )
      expect(screen.getByTestId('image-generate')).toBeDisabled()
    })

    it('says so when this computer has no build', async () => {
      fake.getStatus.mockResolvedValue(
        makeStatus({ install: { state: 'not-installed' } })
      )
      fake.engineCatalog.mockResolvedValue(
        makeEngineCatalog({
          host_backend_id: null,
          host_reason: 'No Intel Mac build.',
        })
      )
      await ready()

      await waitFor(() =>
        expect(screen.getByTestId('audio-engine-notice')).toHaveTextContent(
          'No Intel Mac build.'
        )
      )
    })

    it('draws nothing once it is installed', async () => {
      await ready(QWEN)

      expect(
        screen.queryByTestId('audio-engine-notice')
      ).not.toBeInTheDocument()
    })
  })

  describe('the model list', () => {
    it('lists the mode’s models with their sizes, none of another mode', async () => {
      await ready()
      await openModels()

      const list = screen.getByTestId('audio-models-list')
      expect(within(list).getByText('Qwen3-TTS 1.7B')).toBeInTheDocument()
      expect(within(list).getByText('MOSS-TTS-Nano 100M')).toBeInTheDocument()
      expect(within(list).queryByText('ACE-Step 1.5 Turbo')).toBeNull()
      expect(screen.getByTestId(`audio-model-${MOSS}`)).toHaveTextContent(
        'Apache-2.0'
      )
    })

    const downloadButton = (name: string) =>
      screen.getByRole('button', {
        name: `audios:model.download:${JSON.stringify({ name })}`,
      })

    it('downloads a model and reads the folder again', async () => {
      await ready()
      await openModels()
      const before = fake.listModelFiles.mock.calls.length
      fake.listModelFiles.mockResolvedValue([makeFile(MOSS)])

      await user.click(downloadButton('MOSS-TTS-Nano 100M'))

      await waitFor(() =>
        expect(fake.listModelFiles.mock.calls.length).toBeGreaterThan(before)
      )
      expect(transfer.transferFiles).toHaveBeenCalledTimes(1)
      await waitFor(() =>
        expect(screen.getByTestId(`audio-model-${MOSS}`)).toHaveTextContent(
          'audios:model.downloaded'
        )
      )
    })

    it('installs the engine with a first download when it is missing', async () => {
      fake.getStatus.mockResolvedValue(
        makeStatus({ install: { state: 'not-installed' } })
      )
      await ready()
      const installEngine = vi.fn(async () => {})
      useAudioGenerationStore.setState({ installEngine })
      await openModels()
      fake.listModelFiles.mockResolvedValue([makeFile(MOSS)])

      await user.click(downloadButton('MOSS-TTS-Nano 100M'))

      expect(installEngine).toHaveBeenCalledTimes(1)
      await waitFor(() =>
        expect(screen.getByTestId(`audio-model-${MOSS}`)).toHaveTextContent(
          'audios:model.downloaded'
        )
      )
    })

    it('reports a failed download, with the model’s name', async () => {
      transfer.transferFiles.mockRejectedValue(new Error('No network'))
      await ready()
      await openModels()

      await user.click(downloadButton('MOSS-TTS-Nano 100M'))

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          `audios:model.downloadFailed:${JSON.stringify({ name: 'MOSS-TTS-Nano 100M' })}`,
          { description: 'No network' }
        )
      )
      expect(downloadButton('MOSS-TTS-Nano 100M')).toBeEnabled()
    })

    it('takes a cancel as the user’s choice, not a failure', async () => {
      transfer.transferFiles.mockRejectedValue(new Error('Download cancelled'))
      await ready()
      await openModels()

      await user.click(downloadButton('MOSS-TTS-Nano 100M'))

      await waitFor(() =>
        expect(transfer.transferFiles).toHaveBeenCalledTimes(1)
      )
      expect(toast.error).not.toHaveBeenCalled()
      expect(downloadButton('MOSS-TTS-Nano 100M')).toBeEnabled()
    })

    it('stops a running download from its row', async () => {
      const taskId = audioDownloadTaskId(`${MOSS}:q8_0`)
      useDownloadStore.setState({
        downloads: {
          [taskId]: { name: 'x', progress: 0.1, current: 1, total: 2 },
        },
      })
      await ready()
      await openModels()
      const row = screen.getByTestId(`audio-model-${MOSS}`)
      expect(row).toHaveTextContent('10%')

      await user.click(
        within(row).getByRole('button', { name: 'common:cancelDownload' })
      )

      expect(transfer.cancelTransfer).toHaveBeenCalledWith(taskId)
    })

    it('shows the download’s progress in the row', async () => {
      useDownloadStore.setState({
        downloads: {
          [audioDownloadTaskId(`${MOSS}:q8_0`)]: {
            name: 'x',
            progress: 0.42,
            current: 1,
            total: 2,
          },
        },
      })
      await ready()
      await openModels()

      expect(screen.getByTestId(`audio-model-${MOSS}`)).toHaveTextContent('42%')
    })

    it('marks what is on disk and removes it only once asked', async () => {
      await ready(MOSS)
      await openModels()
      fake.listModelFiles.mockResolvedValue([])

      const row = screen.getByTestId(`audio-model-${MOSS}`)
      expect(row).toHaveTextContent('audios:model.downloaded')
      await user.click(
        within(row).getByRole('button', {
          name: `audios:model.remove:${JSON.stringify({ name: 'MOSS-TTS-Nano 100M' })}`,
        })
      )
      expect(fake.deleteModelFile).not.toHaveBeenCalled()

      await user.click(await screen.findByTestId('audio-model-remove-confirm'))

      expect(fake.deleteModelFile).toHaveBeenCalledWith(
        'moss-tts-nano-100m-q8_0.gguf'
      )
    })

    it('shows Stable Audio’s notice in the row and under the selected model', async () => {
      await ready()
      await modeTo('effects')
      await openModels()

      expect(screen.getByTestId(`audio-model-${SFX}`)).toHaveTextContent(
        'Powered by Stability AI'
      )
      expect(
        within(screen.getByTestId('audio-prompt-card')).getByText(
          'Powered by Stability AI'
        )
      ).toBeInTheDocument()
    })

    it('shows no notice for a model that needs none', async () => {
      await ready()

      expect(screen.queryByTestId('audio-attribution')).not.toBeInTheDocument()
    })
  })

  describe('generating', () => {
    it('keeps Generate off until the model is on disk', async () => {
      await ready()

      expect(screen.getByTestId('image-generate')).toBeDisabled()
      expect(screen.getByTestId('image-empty-state')).toHaveAttribute(
        'data-modality',
        'audio'
      )
      expect(
        screen.getByText('audios:gallery.emptyNoModel')
      ).toBeInTheDocument()

      await user.click(screen.getByTestId('image-empty-download'))
      expect(screen.getByTestId('audio-models-list')).toBeInTheDocument()
    })

    it('needs a prompt', async () => {
      await ready(QWEN)
      expect(screen.getByTestId('image-generate')).toBeEnabled()

      await user.clear(prompt())

      expect(screen.getByTestId('image-generate')).toBeDisabled()
    })

    it('refuses a model that speaks only in a cloned voice', async () => {
      fake.getStatus.mockResolvedValue(makeLoadedStatus())
      fake.getCapabilities.mockResolvedValue({
        modelId: QWEN_WIRE,
        mode: 'speech',
        family: 'qwen3_tts',
        task: 'tts',
        params: [],
        voices: [],
        supportsVoiceRef: true,
        requiresVoiceRef: true,
      })
      await ready(QWEN)

      await waitFor(() =>
        expect(screen.getByTestId('image-generate')).toBeDisabled()
      )
    })

    it('runs a job to a clip, naming phases and never a percentage', async () => {
      fake.generate.mockResolvedValue(makeJob({ state: 'generating' }))
      await ready(QWEN)

      await user.click(screen.getByTestId('image-generate'))
      await screen.findByTestId('image-stop')

      useAudioGenerationStore.getState().handleEvent({
        type: 'job',
        job: makeJob({
          state: 'generating',
          progress: { phase: 'generating', elapsedMs: 500 },
        }),
      })

      const pane = await screen.findByTestId('audio-job-status-pane')
      await waitFor(() =>
        expect(pane).toHaveTextContent('audios:progress.phase.generating')
      )
      expect(pane.textContent).not.toMatch(/%/)
      expect(within(pane).getByRole('progressbar')).not.toHaveAttribute(
        'aria-valuenow'
      )

      useAudioGenerationStore.getState().handleEvent({
        type: 'job',
        job: makeJob({ state: 'completed', output: makeItem('job-1') }),
      })

      expect(await screen.findByTestId('audio-viewer')).toBeInTheDocument()
    })

    it('stops a running job', async () => {
      fake.generate.mockResolvedValue(makeJob({ state: 'generating' }))
      await ready(QWEN)
      await user.click(screen.getByTestId('image-generate'))

      await user.click(await screen.findByTestId('image-stop'))

      expect(fake.cancelJob).toHaveBeenCalledWith('job-1')
      expect(screen.getByTestId('image-stop')).toBeDisabled()
      expect(screen.getByTestId('audio-job-status-pane')).toHaveTextContent(
        'audios:progress.stopping'
      )
    })
  })

  describe('failures', () => {
    it.each([
      ['REQUEST_REJECTED', null],
      ['UNSUPPORTED_MODE', 'retry'],
      ['JOB_BUSY', 'retry'],
      ['MODEL_MISSING', 'chooseModel'],
      ['ENGINE_MISSING', 'install'],
      ['OUT_OF_MEMORY', 'chooseModel'],
    ])('explains %s and offers what fixes it', async (code, action) => {
      await ready(QWEN)

      useAudioGenerationStore.setState({
        lastError: {
          code: code as 'JOB_BUSY',
          message: 'raw',
        },
      })

      const banner = await screen.findByRole('alert')
      expect(banner).toHaveTextContent(`audios:errors.${code}.title`)
      expect(banner).toHaveTextContent(`audios:errors.${code}.body`)
      expect(banner).not.toHaveTextContent('raw')
      if (action) {
        expect(
          within(banner).getByRole('button', {
            name: `audios:errors.actions.${action}`,
          })
        ).toBeInTheDocument()
      } else {
        expect(within(banner).getAllByRole('button')).toHaveLength(1)
      }
    })

    it('quotes what the engine refused', async () => {
      await ready(QWEN)

      useAudioGenerationStore.setState({
        lastError: {
          code: 'REQUEST_REJECTED',
          message: 'raw',
          details: 'requires speaker',
        },
      })

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'requires speaker'
      )
    })

    it('dismisses, and the fix opens the model list', async () => {
      await ready(QWEN)
      useAudioGenerationStore.setState({
        lastError: { code: 'OUT_OF_MEMORY', message: 'raw' },
      })

      await user.click(
        await screen.findByRole('button', {
          name: 'audios:errors.actions.chooseModel',
        })
      )

      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(screen.getByTestId('audio-models-list')).toBeInTheDocument()
    })
  })

  describe('results', () => {
    const items = [
      makeItem('sfx', {
        mode: 'effects',
        modelId: SFX_WIRE,
        text: 'A soft chime',
        sampleRate: 44100,
        channels: 2,
      }),
      makeItem('song', {
        mode: 'music',
        modelId: `${ACE}:q8_0`,
        text: 'Warm chords',
        sampleRate: 48000,
        channels: 2,
      }),
    ]

    beforeEach(() => {
      fake.listGallery.mockResolvedValue({ items, hasMore: false, total: 2 })
    })

    it('reads the gallery back from the core and plays the newest', async () => {
      await ready(QWEN)

      const grid = await screen.findByTestId('audio-gallery-grid')
      expect(within(grid).getAllByRole('button')).toHaveLength(2)
      expect(document.querySelector('audio')).toHaveAttribute(
        'src',
        'asset:///data/audios/sfx.wav'
      )
    })

    it('keeps Stable Audio’s notice on its clips', async () => {
      await ready(QWEN)

      const viewer = await screen.findByTestId('audio-viewer')
      expect(viewer).toHaveTextContent('Powered by Stability AI')
    })

    it('shows the format each clip reports', async () => {
      await ready(QWEN)
      await screen.findByTestId('audio-viewer')

      await user.click(
        screen.getByRole('button', { name: 'audios:viewer.details' })
      )

      expect(await screen.findByText(/44\.1/)).toBeInTheDocument()
    })

    it('opens another clip from the gallery', async () => {
      await ready(QWEN)
      await screen.findByTestId('audio-viewer')

      await user.click(
        screen.getByRole('button', {
          name: `audios:gallery.open:${JSON.stringify({ prompt: 'Warm chords' })}`,
        })
      )

      expect(document.querySelector('audio')).toHaveAttribute(
        'src',
        'asset:///data/audios/song.wav'
      )
    })

    it('loops a clip by its mode’s setting, without telling the engine', async () => {
      await ready(QWEN)
      await screen.findByTestId('audio-viewer')

      useAudioGenerationStore.setState((state) => ({
        forms: {
          ...state.forms,
          effects: { ...state.forms.effects, loop: true },
        },
      }))

      await waitFor(() =>
        expect(document.querySelector('audio')).toHaveProperty('loop', true)
      )
    })

    it('asks before deleting a clip', async () => {
      await ready(QWEN)
      await screen.findByTestId('audio-viewer')

      await user.click(
        screen.getByRole('button', {
          name: /audios:viewer\.deleteClip/,
        })
      )
      expect(fake.deleteGalleryItem).not.toHaveBeenCalled()

      await user.click(await screen.findByTestId('audio-delete-confirm'))

      expect(fake.deleteGalleryItem).toHaveBeenCalledWith('sfx')
      await waitFor(() =>
        expect(useAudioGenerationStore.getState().gallery).toHaveLength(1)
      )
    })

    it('offers more when the core has more', async () => {
      fake.listGallery.mockResolvedValue({ items, hasMore: true, total: 3 })
      await ready(QWEN)
      const more = await screen.findByRole('button', {
        name: 'audios:gallery.loadMore',
      })
      fake.listGallery.mockResolvedValue({
        items: [makeItem('older')],
        hasMore: false,
        total: 3,
      })

      await user.click(more)

      expect(fake.listGallery).toHaveBeenLastCalledWith({
        offset: 2,
        limit: 50,
      })
      const grid = screen.getByTestId('audio-gallery-grid')
      await waitFor(() =>
        expect(within(grid).getAllByRole('button')).toHaveLength(3)
      )
      expect(
        screen.queryByRole('button', { name: 'audios:gallery.loadMore' })
      ).not.toBeInTheDocument()
    })
  })
})
