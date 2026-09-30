import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { WebFetchToolRenderer } from './web-fetch-tool-renderer'

describe('WebFetchToolRenderer', () => {
  it('shows only a uniform favicon, title and domain row', () => {
    const { container } = render(
      <WebFetchToolRenderer
        presentation={{
          kind: 'web_fetch_exa',
          title: 'Read pages',
          pages: [
            {
              title: 'Atomic Chat documentation',
              url: 'https://example.com/docs',
              domain: 'example.com',
              highlights: ['Raw extracted paragraph that should stay hidden'],
            },
          ],
        }}
      />
    )

    expect(screen.getByText('Atomic Chat documentation')).toBeInTheDocument()
    expect(screen.getByText('example.com')).toBeInTheDocument()
    expect(screen.getByRole('link')).toHaveAttribute(
      'href',
      'https://example.com/docs'
    )
    expect(
      screen.queryByText('Raw extracted paragraph that should stay hidden')
    ).not.toBeInTheDocument()
    expect(container.querySelector('svg.lucide-external-link')).toBeNull()
    expect(container.querySelector('.rounded-full')).not.toBeNull()
  })
})
