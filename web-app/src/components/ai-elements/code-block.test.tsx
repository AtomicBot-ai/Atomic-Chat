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

  it('ignores stale highlight results after the props change', async () => {
    const { container, rerender } = render(
      <CodeBlock code="first" language="ts" />
    )

    rerender(<CodeBlock code="second" language="ts" />)

    await act(async () => {
      pending[2]('<pre><code>second-light</code></pre>')
      pending[3]('<pre><code>second-dark</code></pre>')
      await Promise.resolve()
    })

    await waitFor(() =>
      expect(container.textContent).toContain('second-light')
    )

    await act(async () => {
      pending[0]('<pre><code>first-light</code></pre>')
      pending[1]('<pre><code>first-dark</code></pre>')
      await Promise.resolve()
    })

    expect(container.textContent).toContain('second-light')
    expect(container.textContent).not.toContain('first-light')
  })
})
