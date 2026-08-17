import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { toast } from 'sonner'
import { showModelLoadErrorToast } from '../ModelLoadErrorToast'

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}))

vi.mock('@/i18n/setup', () => ({
  default: { t: (key: string) => key },
}))

function lastToast() {
  const calls = vi.mocked(toast.error).mock.calls
  return calls[calls.length - 1]
}

const CRASH_LOG =
  'llama_context: n_ctx_seq (16384) > n_ctx_train (512)\nGGML_ASSERT(n_outputs_max <= cparams.n_outputs_max) failed'

describe('showModelLoadErrorToast', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps the engine log out of the toast until it is asked for', () => {
    showModelLoadErrorToast({
      title: 'Failed to load the model',
      description: 'The model could not be started.',
      details: CRASH_LOG,
      duration: 10000,
    })

    const [title, options] = lastToast()
    expect(title).toBe('Failed to load the model')
    expect(options?.duration).toBe(10000)

    render(<>{options?.description}</>)
    expect(
      screen.getByText('The model could not be started.')
    ).toBeInTheDocument()
    expect(screen.queryByText(/GGML_ASSERT/)).not.toBeInTheDocument()
  })

  it('reveals the log and pins the toast once expanded', () => {
    showModelLoadErrorToast({
      title: 'Failed to load the model',
      description: 'The model could not be started.',
      details: CRASH_LOG,
      duration: 10000,
    })

    render(<>{lastToast()[1]?.description}</>)
    fireEvent.click(
      screen.getByRole('button', { name: /model-errors:showDetails/ })
    )
    cleanup()

    const [, expandedOptions] = lastToast()
    // A log the user is reading must not disappear on the 10s timer.
    expect(expandedOptions?.duration).toBe(Infinity)

    render(<>{expandedOptions?.description}</>)
    expect(screen.getByText(/GGML_ASSERT/)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /model-errors:hideDetails/ })
    ).toBeInTheDocument()
  })

  it('omits the toggle when the engine gave no log', () => {
    showModelLoadErrorToast({
      title: 'Failed to load the model',
      description: 'The model could not be started.',
    })

    render(<>{lastToast()[1]?.description}</>)
    expect(
      screen.getByText('The model could not be started.')
    ).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
