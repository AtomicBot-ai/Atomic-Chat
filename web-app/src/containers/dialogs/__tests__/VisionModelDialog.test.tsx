import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { events } from '@janhq/core'
import type { VisionDownload } from '@/hooks/useVisionDownloads'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  items: [] as VisionDownload[],
  isLoading: false,
  downloads: {} as Record<
    string,
    {
      id: string
      name: string
      progress: number
      current: number
      total: number
      speed: { bytesPerSecond: number; atBytes: number; atTime: number }
    }
  >,
}))

// A minimal in-process bus, so the test drives the dialog the way the
// extension does: by emitting the real event name.
vi.mock('@janhq/core', () => {
  const handlers = new Map<string, Set<(payload: unknown) => void>>()
  return {
    events: {
      on: (name: string, handler: (payload: unknown) => void) => {
        if (!handlers.has(name)) handlers.set(name, new Set())
        handlers.get(name)!.add(handler)
      },
      off: (name: string, handler: (payload: unknown) => void) => {
        handlers.get(name)?.delete(handler)
      },
      emit: (name: string, payload?: unknown) => {
        handlers.get(name)?.forEach((handler) => handler(payload))
      },
    },
    AppEvent: { onModelImported: 'onModelImported' },
  }
})

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}))

vi.mock('@/hooks/useVisionDownloads', () => ({
  useVisionDownloads: () => ({
    items: mocks.items,
    isLoading: mocks.isLoading,
  }),
}))

vi.mock('@/hooks/useDownloadStore', () => {
  const useDownloadStore = (
    selector?: (value: {
      downloads: typeof mocks.downloads
      pausedDownloads: Set<string>
    }) => unknown
  ) =>
    selector
      ? selector({ downloads: mocks.downloads, pausedDownloads: new Set() })
      : { downloads: mocks.downloads, pausedDownloads: new Set() }
  return { useDownloadStore }
})

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ models: () => ({ abortDownload: vi.fn() }) }),
}))

import { VisionModelDialog } from '../VisionModelDialog'

const item = (
  title: string,
  overrides: Partial<VisionDownload> = {}
): VisionDownload => ({
  repo: `org/${title}`,
  title,
  hint: 'hub:recVisionKnowledge',
  sizeLabel: '4.5 GB',
  model: { model_name: `org/${title}`, description: '', downloads: 0 },
  variant: {
    model_id: `${title}-Q4_K_M`,
    path: `https://example.test/${title}.gguf`,
    file_size: '4.5 GB',
  },
  isDownloading: false,
  installed: false,
  start: vi.fn(() => `${title}-Q4_K_M`),
  ...overrides,
})

function renderDialog(
  props: Partial<Parameters<typeof VisionModelDialog>[0]> = {}
) {
  const onOpenChange = vi.fn()
  const onModelReady = vi.fn()
  const view = render(
    <VisionModelDialog
      open
      onOpenChange={onOpenChange}
      onModelReady={onModelReady}
      modelName="LFM2.5 2.6B"
      {...props}
    />
  )
  return { ...view, onOpenChange, onModelReady }
}

describe('VisionModelDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.items = [item('Gemma 4 E4B'), item('Qwen3.5 9B')]
    mocks.isLoading = false
    mocks.downloads = {}
  })

  it('says in plain words that the current model cannot take images', () => {
    renderDialog()

    expect(
      screen.getByRole('heading', {
        name: 'chat:visionGate.title:{"model":"LFM2.5 2.6B"}',
      })
    ).toBeVisible()
    expect(screen.getByText('chat:visionGate.description')).toBeVisible()
    expect(screen.getByText('chat:visionGate.sectionLabel')).toBeVisible()
  })

  it('lists the vision models that run here, each with a Download button', () => {
    renderDialog()

    expect(screen.getByText('Gemma 4 E4B')).toBeVisible()
    expect(screen.getByText('Qwen3.5 9B')).toBeVisible()
    const buttons = screen.getAllByRole('button', {
      name: /chat:visionGate\.downloadLabel/,
    })
    expect(buttons).toHaveLength(2)
    expect(buttons[0]).toHaveTextContent('chat:visionGate.download')
    expect(buttons[0]).toHaveTextContent(/^chat:visionGate\.download$/)
    // Size and reason on one line under each name.
    expect(
      screen.getAllByText(
        'chat:visionGate.rowHint:{"size":"4.5 GB","reason":"chat:visionGate.visionCapable · hub:recVisionKnowledge"}'
      )
    ).toHaveLength(2)
  })

  it('starts the download and shows its progress on the row', () => {
    const { rerender, onOpenChange } = renderDialog()

    fireEvent.click(
      screen.getByRole('button', {
        name: 'chat:visionGate.downloadLabel:{"name":"Gemma 4 E4B"}',
      })
    )
    expect(mocks.items[0].start).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)

    // The store reports progress; the row wears it and the button goes dark.
    mocks.items = [{ ...mocks.items[0], isDownloading: true }, mocks.items[1]]
    mocks.downloads = {
      'Gemma 4 E4B-Q4_K_M': {
        id: 'Gemma 4 E4B-Q4_K_M',
        name: 'Gemma 4 E4B-Q4_K_M',
        progress: 0.42,
        current: 4.2 * 1024 ** 3,
        total: 10 * 1024 ** 3,
        speed: {
          bytesPerSecond: 100 * 1024 ** 2,
          atBytes: 0,
          atTime: 0,
        },
      },
    }
    rerender(
      <VisionModelDialog
        open
        onOpenChange={onOpenChange}
        onModelReady={vi.fn()}
        modelName="LFM2.5 2.6B"
      />
    )

    expect(screen.getByText(/42% · 4\.20 \/ 10\.00 GB/)).toBeVisible()
    expect(
      screen.getByRole('button', {
        name: 'common:cancelDownload',
      })
    ).toHaveTextContent('common:cancel')
  })

  it('hands the model over once its download has been imported', () => {
    const { onModelReady } = renderDialog()

    fireEvent.click(
      screen.getByRole('button', {
        name: 'chat:visionGate.downloadLabel:{"name":"Gemma 4 E4B"}',
      })
    )
    act(() => {
      // Another download finishing is not ours.
      events.emit('onModelImported', { modelId: 'something-else' })
    })
    expect(onModelReady).not.toHaveBeenCalled()

    // No redundant footer action: the titlebar × / outside click dismisses
    // the dialog without cancelling the download.
    expect(screen.queryByText('common:close')).not.toBeInTheDocument()
    expect(screen.queryByText('common:cancel')).not.toBeInTheDocument()

    act(() => {
      events.emit('onModelImported', { modelId: 'Gemma 4 E4B-Q4_K_M' })
    })
    expect(onModelReady).toHaveBeenCalledWith('Gemma 4 E4B-Q4_K_M')
  })

  it('offers a vision model already on disk with Use instead of Download', () => {
    mocks.items = [item('Gemma 4 E4B', { installed: true })]
    const { onModelReady } = renderDialog()

    const button = screen.getByRole('button', {
      name: 'chat:visionGate.useLabel:{"name":"Gemma 4 E4B"}',
    })
    expect(button).toHaveTextContent(/^chat:visionGate\.use$/)
    fireEvent.click(button)

    expect(mocks.items[0].start).not.toHaveBeenCalled()
    expect(onModelReady).toHaveBeenCalledWith('Gemma 4 E4B-Q4_K_M')
  })

  it('sends the rest of Hugging Face to the Hub', () => {
    const { onOpenChange } = renderDialog()

    const row = screen.getByRole('button', {
      name: 'chat:visionGate.huggingFaceLabel',
    })
    expect(row).toHaveTextContent('chat:visionGate.browse')
    expect(screen.getByText('chat:visionGate.huggingFaceTitle')).toBeVisible()
    fireEvent.click(row)

    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/hub/' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('says so when nothing in the list fits this device', () => {
    mocks.items = []
    renderDialog()

    expect(screen.getByText('chat:visionGate.empty')).toBeVisible()
    // The Hub is still a way out.
    expect(
      screen.getByRole('button', { name: 'chat:visionGate.huggingFaceLabel' })
    ).toBeVisible()
  })

  it('shows a spinner line while the list is still resolving', () => {
    mocks.items = []
    mocks.isLoading = true
    renderDialog()

    expect(screen.getByText('chat:visionGate.finding')).toBeVisible()
    expect(screen.queryByText('chat:visionGate.empty')).not.toBeInTheDocument()
  })

  it('names no model in the title when none is selected', () => {
    renderDialog({ modelName: '' })

    expect(
      screen.getByRole('heading', { name: 'chat:visionGate.titleNoModel' })
    ).toBeVisible()
  })
})
