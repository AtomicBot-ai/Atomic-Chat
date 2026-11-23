import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { CompactionDivider } from '@/containers/CompactionDivider'
import type { ThreadCompaction } from '@/lib/context-compaction'

// The real English copy, so a test reads what the person reads.
vi.mock('@/i18n/react-i18next-compat', async () => {
  const { default: i18n } = await import('@/i18n/setup')
  return {
    useTranslation: () => ({
      t: (key: string, options?: Record<string, unknown>) =>
        i18n.t(key, options),
    }),
  }
})

const compaction: ThreadCompaction = {
  summary: 'The user planned a trip to Lisbon.\nThey prefer trains.',
  upToMessageId: 'u3',
  summarizedCount: 12,
  tokensBefore: 28_672,
  tokensAfter: 3_072,
  modelId: 'qwen',
  provider: 'vllm',
  createdAt: 1,
}

describe('CompactionDivider', () => {
  it('says how much was summarized, in one line', () => {
    render(<CompactionDivider compaction={compaction} />)

    expect(
      screen.getByRole('group', { name: 'Earlier messages are summarized' })
    ).toBeInTheDocument()
    expect(screen.getByTestId('compaction-divider-label')).toHaveTextContent(
      'Earlier messages are summarized · 12 messages · 28K → 3K tokens'
    )
    expect(screen.getByTestId('compaction-divider-label')).toHaveClass(
      'min-w-0',
      'truncate'
    )
  })

  it('opens and closes the summary', () => {
    render(<CompactionDivider compaction={compaction} />)

    const toggle = screen.getByRole('button', { name: 'Show summary' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(/planned a trip/)).not.toBeVisible()

    fireEvent.click(toggle)
    expect(
      screen.getByRole('button', { name: 'Hide summary' })
    ).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/planned a trip/)).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Hide summary' }))
    expect(screen.queryByText(/planned a trip/)).not.toBeVisible()
  })

  it('leaves out counts it does not know', () => {
    render(
      <CompactionDivider
        compaction={{
          ...compaction,
          summarizedCount: 1,
          tokensBefore: 0,
          tokensAfter: 0,
        }}
      />
    )
    expect(screen.getByTestId('compaction-divider-label')).toHaveTextContent(
      /^Earlier messages are summarized · 1 message$/
    )
  })
})
