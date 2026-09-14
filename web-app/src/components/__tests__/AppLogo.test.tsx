import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AppLogo } from '../AppLogo'

describe('AppLogo', () => {
  it('names the product Radium, in the wordmark and the tile', () => {
    const { container } = render(<AppLogo />)

    // The sidebar lockup was a drawn "Atomic Chat" wordmark that the text
    // search of the first rename could not see.
    expect(screen.getByText('Radium')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Radium' })).toBeInTheDocument()
    expect(container.innerHTML).not.toMatch(/Atomic (Chat|Bot)/)
  })

  it('paints the wordmark in the colour the caller asks for', () => {
    render(<AppLogo wordmarkClassName="text-sidebar-foreground" />)

    expect(screen.getByText('Radium')).toHaveClass('text-sidebar-foreground')
  })
})
