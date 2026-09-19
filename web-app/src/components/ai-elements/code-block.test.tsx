import { render, waitFor } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const pending: Array<(html: string) => void> = []

const { codeToHtml } = vi.hoisted(() => ({
  codeToHtml: vi.fn(
    () =>
      new Promise<string>((resolve) => {
        pending.push(resolve)
      })
  ),
}))

vi.mock('shiki', () => ({ codeToHtml }))

import { CodeBlock } from './code-block'

describe('CodeBlock', () => {
  beforeEach(() => {
    pending.length = 0
    codeToHtml.mockClear()
  })

  const resolvePair = async (offset: number, prefix: string) => {
    await act(async () => {
      pending[offset](`<pre><code>${prefix}-light</code></pre>`)
      pending[offset + 1](`<pre><code>${prefix}-dark</code></pre>`)
      await Promise.resolve()
    })
  }

  it('ignores stale highlight results after the props change', async () => {
    const { container, rerender } = render(
      <CodeBlock code="first" language="ts" />
    )

    rerender(<CodeBlock code="second" language="ts" />)

    await resolvePair(2, 'second')

    await waitFor(() => {
      expect(container.textContent).toContain('second-light')
      expect(container.textContent).toContain('second-dark')
    })

    await resolvePair(0, 'first')

    expect(container.textContent).toContain('second-light')
    expect(container.textContent).not.toContain('first-light')
  })

  it('drops pending highlight results after unmount', async () => {
    const { unmount } = render(<CodeBlock code="first" language="ts" />)
    unmount()
    await resolvePair(0, 'first')
  })
})
