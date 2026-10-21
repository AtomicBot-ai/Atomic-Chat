import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ParametersSection } from '@/containers/ParametersSection'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

function Harness({
  initial,
  onChange,
}: {
  initial: Record<string, unknown>
  onChange?: (key: string, value: number | boolean) => void
}) {
  const [parameters, setParameters] = useState(initial)
  return (
    <ParametersSection
      parameters={parameters}
      paramKeys={['temperature', 'top_p', 'min_p', 'repeat_penalty']}
      onChange={(key, value) => {
        onChange?.(key, value)
        setParameters((current) => ({ ...current, [key]: value }))
      }}
    />
  )
}

const field = (name: string) =>
  screen.getByRole('spinbutton', { name }) as HTMLInputElement

describe('ParametersSection number fields', () => {
  // QA on 2.2.21: an English UI on a Mac set to the Russian region showed
  // "0,7" and "1,12" here — WKWebView localizes `type="number"` inputs.
  it('shows decimals with a point in a text field, whatever the region', () => {
    render(
      <Harness
        initial={{
          temperature: 0.7,
          top_p: 0.8,
          min_p: 0.05,
          repeat_penalty: 1.12,
        }}
      />
    )

    expect(field('Temperature').value).toBe('0.7')
    expect(field('Top P').value).toBe('0.8')
    expect(field('Min P').value).toBe('0.05')
    expect(field('Repeat Penalty').value).toBe('1.12')
    for (const name of ['Temperature', 'Top P', 'Min P', 'Repeat Penalty']) {
      expect(field(name)).toHaveAttribute('type', 'text')
      expect(field(name)).toHaveAttribute('inputmode', 'decimal')
    }
  })

  it('takes a comma as the decimal separator and shows a point once left', () => {
    const onChange = vi.fn()
    render(<Harness initial={{ temperature: 0.7 }} onChange={onChange} />)
    const input = field('Temperature')

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '0,9' } })
    expect(onChange).toHaveBeenLastCalledWith('temperature', 0.9)
    expect(input.value).toBe('0,9')

    fireEvent.blur(input)
    expect(input.value).toBe('0.9')
  })

  it('keeps an unfinished decimal while it is typed', () => {
    const onChange = vi.fn()
    render(<Harness initial={{ temperature: 0.7 }} onChange={onChange} />)
    const input = field('Temperature')

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.change(input, { target: { value: '1.' } })
    expect(input.value).toBe('1.')
    expect(onChange).toHaveBeenLastCalledWith('temperature', 1)

    fireEvent.change(input, { target: { value: '1.5' } })
    expect(input.value).toBe('1.5')
    expect(onChange).toHaveBeenLastCalledWith('temperature', 1.5)
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('ignores text that is not a number yet', () => {
    const onChange = vi.fn()
    render(<Harness initial={{ temperature: 0.7 }} onChange={onChange} />)
    const input = field('Temperature')

    fireEvent.focus(input)
    for (const value of ['', '-', '.', 'abc', '1,2,3']) {
      fireEvent.change(input, { target: { value } })
    }
    expect(onChange).not.toHaveBeenCalled()

    fireEvent.blur(input)
    expect(input.value).toBe('0.7')
  })

  it('clamps to the range and shows the clamped value once left', () => {
    const onChange = vi.fn()
    render(<Harness initial={{ temperature: 0.7 }} onChange={onChange} />)
    const input = field('Temperature')

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '5' } })
    expect(onChange).toHaveBeenLastCalledWith('temperature', 2)

    fireEvent.blur(input)
    expect(input.value).toBe('2')
  })

  it('steps with the arrow keys by the parameter step, within its range', () => {
    const onChange = vi.fn()
    render(
      <Harness initial={{ top_p: 0.8, min_p: 0.01 }} onChange={onChange} />
    )
    const topP = field('Top P')
    const minP = field('Min P')

    fireEvent.keyDown(topP, { key: 'ArrowUp' })
    expect(onChange).toHaveBeenLastCalledWith('top_p', 0.85)
    expect(topP.value).toBe('0.85')

    fireEvent.keyDown(minP, { key: 'ArrowDown' })
    fireEvent.keyDown(minP, { key: 'ArrowDown' })
    expect(onChange).toHaveBeenLastCalledWith('min_p', 0)
    expect(minP.value).toBe('0')
  })
})
