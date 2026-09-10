import { render, screen } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ToolOutput } from './tool'

describe('ToolOutput', () => {
  beforeAll(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    )
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  it('renders multiline result fields as real text blocks', () => {
    const { container } = render(
      <ToolOutput
        output={{
          status: 'ok',
          summary: 'dir\tqwe\nfile\t.DS_Store\nfile\tplanets.md',
        }}
        resolver={(value) => Promise.resolve(value)}
      />
    )

    expect(screen.getByText('summary')).toBeInTheDocument()
    expect(container.textContent).toContain(
      'dir\tqwe\nfile\t.DS_Store\nfile\tplanets.md'
    )
    expect(container.textContent).not.toContain('\\n')
  })
})
