import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// motion caches the media query once per process, so the hook is stubbed
// rather than `matchMedia`.
const motion = vi.hoisted(() => ({ reduced: false }))
vi.mock('motion/react', () => ({
  useReducedMotion: () => motion.reduced,
}))

import { LazyAtomicLogo } from '../LazyAtomicLogo'

describe('LazyAtomicLogo', () => {
  beforeEach(() => {
    motion.reduced = false
  })

  it('displaces the whole mark through its own filter', () => {
    const { container } = render(<LazyAtomicLogo />)

    const logo = screen.getByRole('img', { name: 'Atomic Chat' })
    expect(logo).toHaveClass('lazy-atomic-logo', 'size-28')
    // The colour filter is on the <svg>, where WebKit applies it too.
    expect(logo).toHaveClass('brightness-0', 'dark:invert')
    expect(container.querySelector('image')).not.toHaveAttribute('class')

    const filter = container.querySelector('filter')!
    expect(filter.id).toMatch(/^lazy-atomic-[\w-]+$/)
    expect(container.querySelector('g')).toHaveAttribute(
      'filter',
      `url(#${filter.id})`
    )
    expect(container.querySelector('animate')).toBeInTheDocument()
    expect(container.querySelector('feDisplacementMap')).toHaveAttribute(
      'scale',
      '5'
    )
  })

  it('stays still when the system asks for reduced motion', () => {
    motion.reduced = true
    const { container } = render(<LazyAtomicLogo />)

    expect(container.querySelector('animate')).not.toBeInTheDocument()
    expect(container.querySelector('feDisplacementMap')).toHaveAttribute(
      'scale',
      '0'
    )
  })

  it('gives each mounted logo its own filter id', () => {
    const { container } = render(
      <>
        <LazyAtomicLogo />
        <LazyAtomicLogo />
      </>
    )

    const ids = [...container.querySelectorAll('filter')].map((f) => f.id)
    expect(new Set(ids).size).toBe(2)
  })
})
