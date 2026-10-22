import { describe, it, expect } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { AvatarEmoji } from '../AvatarEmoji'

describe('AvatarEmoji Component', () => {
  it('should return null when no avatar is provided', () => {
    const { container } = render(<AvatarEmoji />)
    expect(container.firstChild).toBeNull()
  })

  it('should return null when avatar is undefined', () => {
    const { container } = render(<AvatarEmoji avatar={undefined} />)
    expect(container.firstChild).toBeNull()
  })

  it('should render image when avatar is a custom image path', () => {
    render(<AvatarEmoji avatar="/images/custom-avatar.png" />)
    
    const img = screen.getByRole('img')
    expect(img).toBeDefined()
    expect(img).toHaveAttribute('src', '/images/custom-avatar.png')
    expect(img).toHaveAttribute('alt', 'Custom avatar')
  })

  it('should apply default image className', () => {
    render(<AvatarEmoji avatar="/images/avatar.jpg" />)
    
    const img = screen.getByRole('img')
    expect(img).toHaveClass('w-5', 'h-5', 'object-contain')
  })

  it('should apply custom image className', () => {
    render(
      <AvatarEmoji 
        avatar="/images/avatar.jpg" 
        imageClassName="w-10 h-10 rounded-full" 
      />
    )
    
    const img = screen.getByRole('img')
    expect(img).toHaveClass('w-10', 'h-10', 'rounded-full')
    expect(img).not.toHaveClass('w-5', 'h-5', 'object-contain')
  })

  it('should render emoji as text span', () => {
    render(<AvatarEmoji avatar="🤖" />)
    
    const span = screen.getByText('🤖')
    expect(span.tagName).toBe('SPAN')
  })

  it('should apply default text className for emoji', () => {
    render(<AvatarEmoji avatar="😊" />)
    
    const span = screen.getByText('😊')
    expect(span).toHaveClass('text-base')
  })

  it('should apply custom text className for emoji', () => {
    render(
      <AvatarEmoji 
        avatar="🎯" 
        textClassName="text-lg font-bold" 
      />
    )
    
    const span = screen.getByText('🎯')
    expect(span).toHaveClass('text-lg', 'font-bold')
    expect(span).not.toHaveClass('text-base')
  })

  it('should render text content as span', () => {
    render(<AvatarEmoji avatar="AI" />)
    
    const span = screen.getByText('AI')
    expect(span.tagName).toBe('SPAN')
    expect(span).toHaveClass('text-base')
  })

  it('should handle React node as avatar', () => {
    const customNode = <div data-testid="custom-node">Custom</div>
    render(<AvatarEmoji avatar={customNode} />)
    
    const span = screen.getByText('Custom')
    expect(span.closest('span')).toHaveClass('text-base')
    expect(screen.getByTestId('custom-node')).toBeDefined()
  })

  it('should not treat non-image paths as custom images', () => {
    render(<AvatarEmoji avatar="/api/data" />)
    
    const span = screen.getByText('/api/data')
    expect(span.tagName).toBe('SPAN')
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('should not treat relative paths as custom images', () => {
    render(<AvatarEmoji avatar="images/avatar.png" />)
    
    const span = screen.getByText('images/avatar.png')
    expect(span.tagName).toBe('SPAN')
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('should handle different image extensions', () => {
    const extensions = ['.png', '.jpg', '.jpeg', '.gif', '.svg']
    
    extensions.forEach((ext, index) => {
      const { unmount } = render(<AvatarEmoji avatar={`/images/avatar${ext}`} />)
      
      const img = screen.getByRole('img')
      expect(img).toHaveAttribute('src', `/images/avatar${ext}`)
      
      unmount()
    })
  })

  it('should maintain accessibility for custom images', () => {
    render(<AvatarEmoji avatar="/images/user-avatar.png" />)
    
    const img = screen.getByRole('img')
    expect(img).toHaveAttribute('alt', 'Custom avatar')
  })

  // QA 2.2.23 #12: an assistant without an avatar showed an empty tile.
  describe('fallback for an assistant without a usable avatar', () => {
    const fallbackOf = (container: HTMLElement) =>
      container.querySelector('[data-slot="avatar-fallback"]')

    it('shows the first letter of the name when there is no avatar', () => {
      const { container } = render(
        <AvatarEmoji avatar={undefined} name="RC 2.2.0 QA Assistant" />
      )
      expect(fallbackOf(container)).toHaveTextContent(/^R$/)
      expect(fallbackOf(container)).toHaveAttribute('aria-hidden', 'true')
    })

    it('treats a blank avatar as missing', () => {
      const { container } = render(<AvatarEmoji avatar="  " name="writer" />)
      expect(fallbackOf(container)).toHaveTextContent(/^W$/)
    })

    it('falls back when the avatar image fails to load, and retries a new one', () => {
      const { container, rerender } = render(
        <AvatarEmoji avatar="/images/gone.png" name="Research" />
      )
      fireEvent.error(screen.getByRole('img'))
      expect(screen.queryByRole('img')).toBeNull()
      expect(fallbackOf(container)).toHaveTextContent(/^R$/)

      rerender(<AvatarEmoji avatar="/images/other.png" name="Research" />)
      expect(screen.getByRole('img')).toHaveAttribute(
        'src',
        '/images/other.png'
      )
    })

    it('uses the assistant glyph for a name without a letter or digit', () => {
      const { container } = render(<AvatarEmoji name="  --  " />)
      const fallback = fallbackOf(container)
      expect(fallback).not.toBeNull()
      expect(fallback!.querySelector('svg')).not.toBeNull()
    })

    it('sizes the initial to the slot it is given', () => {
      const { container } = render(
        <AvatarEmoji name="Writer" fallbackClassName="size-6 text-base" />
      )
      expect(fallbackOf(container)).toHaveClass('size-6', 'text-base')
      expect(fallbackOf(container)).not.toHaveClass('size-4')
    })

    it('renders a given fallback instead of the initial, also for a broken image', () => {
      const { rerender } = render(
        <AvatarEmoji name="Writer" fallback={<span>pick</span>} />
      )
      expect(screen.getByText('pick')).toBeInTheDocument()

      rerender(
        <AvatarEmoji
          avatar="/images/gone.png"
          name="Writer"
          fallback={<span>pick</span>}
        />
      )
      fireEvent.error(screen.getByRole('img'))
      expect(screen.getByText('pick')).toBeInTheDocument()
    })

    it.each([
      ['  écrivain', 'É'],
      ['2.2 QA', '2'],
      ['— помощник', 'П'],
    ])(
      'takes the first letter or digit of %j, upper-cased',
      (name, initial) => {
        const { container } = render(<AvatarEmoji name={name} />)
        expect(fallbackOf(container)?.textContent).toBe(initial)
      }
    )
  })
})
