import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Conversation } from './conversation'

vi.mock('use-stick-to-bottom', () => {
  const StickToBottom = ({
    children,
    initial,
    resize,
    ...props
  }: React.ComponentProps<'div'> & {
    initial?: string
    resize?: string
  }) => (
    <div data-initial={initial} data-resize={resize} {...props}>
      {children}
    </div>
  )

  StickToBottom.Content = ({ children }: React.ComponentProps<'div'>) => (
    <div>{children}</div>
  )

  return {
    StickToBottom,
    useStickToBottomContext: () => ({
      isAtBottom: true,
      scrollToBottom: vi.fn(),
    }),
  }
})

describe('Conversation', () => {
  it('does not restart smooth scrolling for every streaming resize', () => {
    render(<Conversation>Message</Conversation>)

    const conversation = screen.getByRole('log')
    expect(conversation).toHaveAttribute('data-initial', 'smooth')
    expect(conversation).toHaveAttribute('data-resize', 'instant')
  })
})
