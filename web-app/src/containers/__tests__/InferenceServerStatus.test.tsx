import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppState } from '@/hooks/useAppState'
import { useModelLoad } from '@/hooks/useModelLoad'
import { useModelProvider } from '@/hooks/useModelProvider'
import {
  InferenceServerStatusLine,
  InferenceServerStatusStrip,
} from '../InferenceServerStatus'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) =>
      options?.model ? `${key}:${options.model}` : key,
  }),
}))

// The strip reads the failure through the same describe function the toast
// uses; here it only has to be deterministic.
vi.mock('@/utils/switchModel', () => ({
  describeModelLoadFailure: vi.fn(() => ({
    title: 'Model file is corrupted',
    description: 'Delete the model and download it again.',
    persistent: false,
  })),
  switchToModel: vi.fn(),
}))

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({}),
}))

const MODEL = 'AtomicChat/Qwen3.6-27B-GGUF'

const seed = (
  app: Partial<ReturnType<typeof useAppState.getState>>,
  provider = 'llamacpp'
) => {
  useAppState.setState({
    activeModels: [],
    loadingModel: false,
    loadingModelId: undefined,
    loadingModelKind: undefined,
    ...app,
  })
  useModelProvider.setState({
    selectedProvider: provider,
    selectedModel: { id: MODEL } as never,
  })
}

// The repo tags with `data-test-id`; RTL's default query looks for `data-testid`.
const byTestId = (id: string) =>
  document.querySelector(`[data-test-id="${id}"]`)
const strip = () => byTestId('inference-server-status')

describe('InferenceServerStatusStrip', () => {
  beforeEach(() => {
    useModelLoad.setState({
      modelLoadError: undefined,
      modelLoadErrorModelId: undefined,
    })
    seed({})
  })

  // ATO-530: a load in flight is the loading snackbar's to tell — with its
  // step and a Cancel. The strip repeating "starting" would be the same news
  // twice.
  it('leaves a load in flight to the loading snackbar', () => {
    for (const kind of ['start', 'restart'] as const) {
      seed({
        loadingModel: true,
        loadingModelId: MODEL,
        loadingModelKind: kind,
      })

      const { container, unmount } = render(<InferenceServerStatusStrip />)

      expect(container).toBeEmptyDOMElement()
      unmount()
    }
  })

  // The whole point of ATO-535: an auto-started load that fails raises no
  // toast, so this strip is the only place the reason is ever shown.
  it('spells out a failure and offers a way to retry it', () => {
    useModelLoad.setState({
      modelLoadError: { code: 'MODEL_FILE_CORRUPT' } as never,
      modelLoadErrorModelId: MODEL,
    })
    seed({})

    render(<InferenceServerStatusStrip />)

    expect(strip()).toHaveAttribute('data-phase', 'failed')
    expect(screen.getByText('Model file is corrupted')).toBeInTheDocument()
    expect(
      screen.getByText('Delete the model and download it again.')
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'common:inferenceStatus.retry' })
    ).toBeInTheDocument()
  })

  it('takes no room in a steady state', () => {
    seed({ activeModels: [MODEL] })

    const { container } = render(<InferenceServerStatusStrip />)

    expect(container).toBeEmptyDOMElement()
  })

  it('stays out of the way of a remote provider', () => {
    // The switch path flips `loadingModel` for a cloud model too; there is no
    // engine here to describe, so the strip says nothing rather than claiming
    // somebody else's server is loading into memory.
    seed({ loadingModel: true, loadingModelId: MODEL }, 'openai')

    const { container } = render(<InferenceServerStatusStrip />)

    expect(container).toBeEmptyDOMElement()
  })
})

describe('InferenceServerStatusLine', () => {
  beforeEach(() => {
    useModelLoad.setState({
      modelLoadError: undefined,
      modelLoadErrorModelId: undefined,
    })
    seed({})
  })

  it('reads "loaded" without needing a tooltip', () => {
    seed({ activeModels: [MODEL] })

    render(<InferenceServerStatusLine />)

    const line = byTestId('inference-server-status-line')
    expect(line).toHaveAttribute('data-phase', 'ready')
    expect(line).toHaveTextContent('common:inferenceStatus.ready')
  })

  it('says so when nothing is loaded', () => {
    render(<InferenceServerStatusLine />)

    expect(byTestId('inference-server-status-line')).toHaveAttribute(
      'data-phase',
      'notLoaded'
    )
  })

  it('has nothing to report for a remote model', () => {
    seed({}, 'openai')

    const { container } = render(<InferenceServerStatusLine />)

    expect(container).toBeEmptyDOMElement()
  })
})
