import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Card, CardItem } from '../Card'

describe('Card', () => {
  it('draws the bordered content surface by default', () => {
    render(<Card title="Engine settings">body</Card>)

    const card = screen.getByText('Engine settings').parentElement!
    expect(card).toHaveClass(
      'content-card',
      'px-4',
      'py-3.5',
      'border',
      'border-border',
      'bg-card',
      'rounded-xl'
    )
  })

  it('keeps the surface when a caller only adds layout classes', () => {
    render(
      <Card title="Connector" className="flex flex-col gap-3">
        body
      </Card>
    )

    const card = screen.getByText('Connector').parentElement!
    expect(card).toHaveClass('flex', 'bg-card', 'border', 'rounded-xl')
  })

  it('lets an embedded card drop its own surface', () => {
    // How EngineDetail unfolds its settings inside the engine's card.
    render(
      <Card
        title="Embedded"
        className="rounded-none border-0 bg-transparent p-0"
      >
        body
      </Card>
    )

    const card = screen.getByText('Embedded').parentElement!
    expect(card).toHaveClass('border-0', 'bg-transparent', 'p-0')
    expect(card).not.toHaveClass('bg-card', 'rounded-xl', 'px-4', 'border')
  })
})

describe('CardItem', () => {
  it('lets a long title shrink beside its action', () => {
    render(<CardItem title="A very long setting name" actions={<button />} />)

    const copy = screen.getByText('A very long setting name').parentElement!
    expect(copy).toHaveClass('min-w-0')
    expect(copy.parentElement).toHaveClass('mt-3', 'pb-3', 'gap-5')
  })
})
