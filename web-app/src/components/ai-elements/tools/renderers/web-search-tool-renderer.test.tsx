import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
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
    expect(container.querySelector('.max-h-80.overflow-y-auto')).not.toBeNull()
  })
})
