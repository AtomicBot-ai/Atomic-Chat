import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AttachmentChip } from './AttachmentChip'

describe('AttachmentChip remove affordance', () => {
  it('keeps the neutral remove button hidden until hover or keyboard focus', () => {
    render(<AttachmentChip name="notes.txt" onRemove={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'Remove' })).toHaveClass(
      'bg-foreground',
      'text-background',
      'opacity-0',
      'group-hover/chip:opacity-100',
      'focus-visible:opacity-100'
    )
    expect(screen.getByRole('button', { name: 'Remove' })).not.toHaveClass(
      'bg-destructive'
    )
  })
})
