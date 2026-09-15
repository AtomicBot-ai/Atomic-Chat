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

  it('shows the full-colour Radium logo as it is, never inverted or tinted', () => {
    render(<AppLogo />)

    // The user's new logo (2026-09-14) is a colour tile; the old black-and-white
    // mark was inverted onto a black or white tile, which would spoil it.
    const logo = screen.getByRole('img', { name: 'Radium' })
    expect(logo).toHaveAttribute('src', '/images/transparent-logo.png')
    expect(logo.className).not.toMatch(/invert|brightness/)
    expect(logo.parentElement?.className ?? '').not.toMatch(
      /bg-neutral-950|dark:bg-white/
    )
  })

  it('paints the wordmark in the colour the caller asks for', () => {
    render(<AppLogo wordmarkClassName="text-sidebar-foreground" />)

    expect(screen.getByText('Radium')).toHaveClass('text-sidebar-foreground')
  })
})
