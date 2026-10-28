import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { describe, expect, it, vi } from 'vitest'

import { InputControl } from '../InputControl'

describe('InputControl, as a number', () => {
  it('reads minus, value, plus, and steps within its bounds', () => {
    const onChange = vi.fn()
    render(
      <InputControl type="number" value={4} min={0} max={5} onChange={onChange} />
    )
    const group = screen.getByRole('group')
    expect(
      Array.from(group.children).map(
        (child) => child.getAttribute('aria-label') ?? child.tagName
      )
    ).toEqual(['Decrement', 'INPUT', 'Increment'])

    fireEvent.click(screen.getByRole('button', { name: 'Increment' }))
    expect(onChange).toHaveBeenLastCalledWith('5')
    fireEvent.click(screen.getByRole('button', { name: 'Decrement' }))
    expect(onChange).toHaveBeenLastCalledWith('3')
  })

  it('keeps an emptied field empty instead of letting go of its value', () => {
    const { rerender } = render(
      <InputControl type="number" value={8} onChange={() => {}} />
    )
    rerender(<InputControl type="number" value="" onChange={() => {}} />)
    expect(screen.getByRole('textbox')).toHaveValue('')
  })
})
