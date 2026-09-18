import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { WebSearchToolRenderer } from './web-search-tool-renderer'

describe('WebSearchToolRenderer', () => {
  it('renders every result inside a bounded scroll area', () => {
    const { container } = render(
      <WebSearchToolRenderer
        presentation={{
          kind: 'web_search_exa',
          title: 'Searched: Atomic Chat',
          results: Array.from({ length: 6 }, (_, index) => ({
            title: `Result ${index + 1}`,
            url: `https://example.com/${index + 1}`,
            highlights: [],
          })),
        }}
      />
    )

    expect(screen.getAllByText(/^Result \d$/)).toHaveLength(6)
    expect(screen.getAllByRole('link')).toHaveLength(6)
    expect(screen.getAllByText('example.com')).toHaveLength(6)
    expect(screen.getByText('chat:toolCall.results')).toBeInTheDocument()
    const scroller = container.querySelector(
      '.max-h-64.overflow-y-auto'
    ) as HTMLElement
    expect(scroller).not.toBeNull()
    expect(scroller).toHaveClass('[scrollbar-gutter:stable]')
  })

  it('shows a compact clean error with a retry action', async () => {
    const retry = vi.fn()
    const { container } = render(
      <WebSearchToolRenderer
        presentation={{
          kind: 'web_search_exa',
          title: 'Web search failed',
          results: [],
          errorText:
            'Error: "Web search is temporarily unavailable. Try again."',
        }}
        onRetry={retry}
      />
    )

    expect(
      screen.getByText('Web search is temporarily unavailable. Try again.')
    ).toBeInTheDocument()
    expect(container.innerHTML).not.toContain('bg-destructive/10')
    await userEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(retry).toHaveBeenCalledOnce()
  })
})
