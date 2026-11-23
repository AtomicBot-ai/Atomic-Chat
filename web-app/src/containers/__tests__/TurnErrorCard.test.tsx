import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { TurnErrorCard } from '@/containers/TurnErrorCard'
import { formatTransportError } from '@/lib/transport-error'

const CONTEXT_OVERFLOW_TITLE = 'chat:turnRecovery.contextOverflowTitle'
const INCREASE_CONTEXT = 'chat:turnRecovery.increaseContext'

const ENGINE_GONE = formatTransportError(
  'connection_reset',
  'connection reset by peer (os error 54)'
)

function renderCard(
  error: unknown,
  props: Partial<Parameters<typeof TurnErrorCard>[0]> = {}
) {
  const handlers = {
    onRetry: vi.fn(),
    onShortenHistory: vi.fn(),
    onCompactHistory: vi.fn(),
    onIncreaseContext: vi.fn(),
    onOpenEngineSettings: vi.fn(),
  }
  render(
    <TurnErrorCard
      error={error}
      providerId="llamacpp-upstream"
      {...handlers}
      {...props}
    />
  )
  return handlers
}

describe('TurnErrorCard', () => {
  it('is an alert named by its title, with the icon hidden from assistive tech', () => {
    renderCard(new Error(ENGINE_GONE))

    const alert = screen.getByRole('alert', {
      name: 'chat:turnRecovery.engineGoneTitle',
    })
    expect(alert).toHaveTextContent('chat:turnRecovery.engineGoneMessage')
    for (const icon of alert.querySelectorAll('svg')) {
      expect(icon).toHaveAttribute('aria-hidden', 'true')
    }
  })

  it('keeps the raw diagnostic in a collapsed, focusable Details region', () => {
    renderCard(new Error(ENGINE_GONE))

    const summary = screen.getByText('chat:turnRecovery.details')
    expect(summary.tagName).toBe('SUMMARY')
    const details = summary.closest('details')!
    expect(details.open).toBe(false)
    expect(details).toHaveTextContent(ENGINE_GONE)
    // The raw text appears once, only inside Details.
    expect(screen.getAllByText(ENGINE_GONE)).toHaveLength(1)

    summary.focus()
    expect(summary).toHaveFocus()
    fireEvent.click(summary)
    expect(details.open).toBe(true)
  })

  it('retries with a labelled button', () => {
    const { onRetry } = renderCard(new Error(ENGINE_GONE))

    const retry = screen.getByRole('button', {
      name: 'chat:turnRecovery.retry',
    })
    // A visible text label, not an icon with an accessible name only.
    expect(retry).toHaveTextContent('chat:turnRecovery.retry')
    expect(screen.getAllByRole('button')).toHaveLength(1)
    fireEvent.click(retry)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('says a settings change restarted the model', () => {
    renderCard(new Error(ENGINE_GONE), { settingsRestartModel: 'Qwen3.5 4B' })

    expect(
      screen.getByRole('alert', {
        name: 'chat:turnRecovery.settingsRestartTitle',
      })
    ).toBeInTheDocument()
    expect(
      screen.getByText('chat:turnRecovery.settingsRestartMessage')
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'chat:turnRecovery.retry' })
    ).toBeInTheDocument()
  })

  it('offers the same context-overflow actions as before', () => {
    const overflow = new Error(
      'the request exceeds the available context size.'
    )
    const grow = renderCard(overflow)
    fireEvent.click(screen.getByRole('button', { name: INCREASE_CONTEXT }))
    expect(grow.onIncreaseContext).toHaveBeenCalledTimes(1)
    expect(
      screen.getByRole('alert', { name: CONTEXT_OVERFLOW_TITLE })
    ).toBeInTheDocument()
  })

  it('offers to shorten history when the context cannot grow', () => {
    const { onShortenHistory } = renderCard(
      new Error('the request exceeds the available context size.'),
      { contextGrowthBlocked: true }
    )
    expect(
      screen.getByRole('alert', { name: CONTEXT_OVERFLOW_TITLE })
    ).toBeInTheDocument()
    // The one action offered: growing the context is no longer possible.
    expect(screen.queryByRole('button', { name: INCREASE_CONTEXT })).toBeNull()
    fireEvent.click(
      screen.getByRole('button', { name: 'chat:turnRecovery.shortenHistory' })
    )
    expect(onShortenHistory).toHaveBeenCalledTimes(1)
  })

  it('never offers to grow a cloud model’s context: it offers to shorten the history', () => {
    const { onShortenHistory, onIncreaseContext } = renderCard(
      new Error(
        "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens."
      ),
      { providerId: 'openai' }
    )
    expect(
      screen.getByRole('alert', { name: CONTEXT_OVERFLOW_TITLE })
    ).toHaveTextContent('chat:turnRecovery.contextOverflowShortenMessage')
    expect(screen.queryByRole('button', { name: INCREASE_CONTEXT })).toBeNull()
    fireEvent.click(
      screen.getByRole('button', { name: 'chat:turnRecovery.shortenHistory' })
    )
    expect(onShortenHistory).toHaveBeenCalledTimes(1)
    expect(onIncreaseContext).not.toHaveBeenCalled()
  })

  it("opens a managed engine's settings for its overflow", () => {
    const { onOpenEngineSettings } = renderCard(
      new Error(
        "This model's maximum context length is 4096 tokens. [context_length_exceeded]"
      ),
      { providerId: 'vllm' }
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open vLLM settings' }))
    expect(onOpenEngineSettings).toHaveBeenCalledWith('vllm')
    expect(screen.queryByText('chat:turnRecovery.details')).toBeNull()
  })

  it('offers to compact the history first wherever it can be compacted', () => {
    const overflow = new Error(
      'the request exceeds the available context size.'
    )
    const { onCompactHistory, onIncreaseContext, onShortenHistory } =
      renderCard(overflow, { compactionAvailable: true })

    expect(
      screen.getByRole('alert', { name: CONTEXT_OVERFLOW_TITLE })
    ).toHaveTextContent('chat:turnRecovery.contextOverflowCompactMessage')
    // One action: compacting comes before growing or shortening.
    expect(screen.getAllByRole('button')).toHaveLength(1)
    fireEvent.click(
      screen.getByRole('button', { name: 'chat:turnRecovery.compactAndRetry' })
    )
    expect(onCompactHistory).toHaveBeenCalledTimes(1)
    expect(onIncreaseContext).not.toHaveBeenCalled()
    expect(onShortenHistory).not.toHaveBeenCalled()
  })

  it('compacts a managed engine overflow, its own words under Details', () => {
    const { onCompactHistory, onOpenEngineSettings } = renderCard(
      new Error(
        "This model's maximum context length is 4096 tokens. [context_length_exceeded]"
      ),
      { providerId: 'vllm', compactionAvailable: true }
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'chat:turnRecovery.compactAndRetry' })
    )
    expect(onCompactHistory).toHaveBeenCalledTimes(1)
    expect(onOpenEngineSettings).not.toHaveBeenCalled()
    expect(screen.getByText('chat:turnRecovery.details')).toBeInTheDocument()
  })

  it('falls back to shortening the history when compaction is unavailable', () => {
    const { onShortenHistory } = renderCard(
      new Error('the request exceeds the available context size.'),
      { providerId: 'foundry-local', compactionAvailable: false }
    )
    expect(
      screen.queryByRole('button', {
        name: 'chat:turnRecovery.compactAndRetry',
      })
    ).toBeNull()
    fireEvent.click(
      screen.getByRole('button', { name: 'chat:turnRecovery.shortenHistory' })
    )
    expect(onShortenHistory).toHaveBeenCalledTimes(1)
  })

  it('never offers compaction without a handler for it', () => {
    render(
      <TurnErrorCard
        error={new Error('the request exceeds the available context size.')}
        providerId="llamacpp-upstream"
        compactionAvailable
        onRetry={vi.fn()}
        onShortenHistory={vi.fn()}
        onIncreaseContext={vi.fn()}
        onOpenEngineSettings={vi.fn()}
      />
    )
    expect(
      screen.getByRole('button', { name: INCREASE_CONTEXT })
    ).toBeInTheDocument()
  })

  it('shows a readable provider message as the body with working links and no Details', () => {
    renderCard(
      new Error(
        'Accept the model terms first: [View agreement](https://example.com/terms)'
      ),
      { providerId: 'openrouter' }
    )

    expect(
      screen.getByRole('link', { name: 'View agreement' })
    ).toHaveAttribute('href', 'https://example.com/terms')
    expect(screen.queryByText('chat:turnRecovery.details')).toBeNull()
  })

  it('puts a JSON envelope behind Details with a readable sentence', () => {
    const envelope = '{"error":{"code":500,"message":"slot unavailable"}}'
    renderCard(new Error(envelope), { providerId: 'openrouter' })

    expect(
      screen.getByText('chat:turnRecovery.genericMessage')
    ).toBeInTheDocument()
    expect(screen.getAllByText(envelope)).toHaveLength(1)
    expect(screen.getByText(envelope).closest('details')).not.toBeNull()
  })
})
