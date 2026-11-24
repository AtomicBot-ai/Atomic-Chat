import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'

import { ContextActivity } from '../ContextActivity'
import { useAppState } from '@/hooks/useAppState'

// The real English copy, so a test reads what the person reads.
vi.mock('@/i18n/react-i18next-compat', async () => {
  const { default: i18n } = await import('@/i18n/setup')
  return {
    useTranslation: (namespace?: string) => ({
      t: (key: string, options?: Record<string, unknown>) =>
        i18n.t(
          key.includes(':') || !namespace ? key : `${namespace}:${key}`,
          options
        ),
    }),
  }
})

const setActivity = (
  contextActivity: ReturnType<typeof useAppState.getState>['contextActivity'],
  promptProgress?: ReturnType<typeof useAppState.getState>['promptProgress']
) => act(() => useAppState.setState({ contextActivity, promptProgress }))

describe('ContextActivity', () => {
  beforeEach(() => setActivity({ phase: null }, undefined))

  it('names the growth with both window sizes while the model restarts', () => {
    setActivity({ phase: 'expanding', from: 16384, to: 65536, threadId: 't-1' })
    render(<ContextActivity threadId="t-1" />)

    expect(screen.getByText('Adding context: 16K → 64K')).toBeVisible()
    // Open from the start: the detail is the point.
    expect(screen.getByText('Restarting the model…')).toBeVisible()
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('says only that context is being added before the new size is known', () => {
    setActivity({ phase: 'expanding', from: 16384, threadId: 't-1' })
    render(<ContextActivity threadId="t-1" />)
    expect(screen.getByText('Adding context…')).toBeVisible()
  })

  it('reads as a growth of unknown size when nothing is recorded for the thread', () => {
    setActivity({ phase: 'compacting', threadId: 'another-thread' })
    render(<ContextActivity threadId="t-1" />)
    expect(screen.getByText('Adding context…')).toBeVisible()
    expect(screen.queryByText('Compacting chat history…')).toBeNull()
  })

  it('shows the reading progress once the engine reports it', () => {
    setActivity(
      { phase: 'expanding', from: 16384, to: 65536, threadId: 't-1' },
      { total: 49152, processed: 12288, cache: 0, time_ms: 900 }
    )
    render(<ContextActivity threadId="t-1" />)

    expect(
      screen.getByText('Reading the conversation: 12K / 48K tokens')
    ).toBeVisible()
    expect(screen.getByRole('progressbar')).toHaveAttribute(
      'aria-valuenow',
      '25'
    )
    expect(screen.getByText('25%')).toBeVisible()
    expect(screen.queryByText('Restarting the model…')).toBeNull()
  })

  it('names a compaction, with the reading progress when known', () => {
    setActivity({ phase: 'compacting', threadId: 't-1' })
    const view = render(<ContextActivity threadId="t-1" />)
    expect(screen.getByText('Compacting chat history…')).toBeVisible()
    expect(screen.queryByTestId('context-activity-detail')).toBeNull()

    setActivity(
      { phase: 'compacting', threadId: 't-1' },
      { total: 800, processed: 400, cache: 0, time_ms: 10 }
    )
    view.rerender(<ContextActivity threadId="t-1" />)
    expect(
      screen.getByText('Reading the conversation: 400 / 800 tokens')
    ).toBeVisible()
  })
})
