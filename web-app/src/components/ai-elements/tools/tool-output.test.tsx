import { render, screen } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ToolOutput } from './tool'

// This test covers ToolOutput's multiline rendering, not Shiki. Keep the
// highlighter deterministic so no Shiki worker/promise survives jsdom teardown
// and touches `window` after the test has finished.
vi.mock('../code-block', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../code-block')>()
  return {
    ...actual,
    highlightCode: vi.fn().mockResolvedValue(['', '']),
  }
})

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
