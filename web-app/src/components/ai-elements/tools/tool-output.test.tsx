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

  it('plays a video a generation result points at, above the raw text', () => {
    const { container } = render(
      <ToolOutput
        output={{
          content: [
            {
              type: 'text',
              text: 'status: completed\nrawUrl: https://cdn.example.com/spot.mp4',
            },
          ],
        }}
        resolver={(value) => Promise.resolve(value)}
      />
    )

    const video = container.querySelector('video')
    expect(video).not.toBeNull()
    expect(video?.getAttribute('src')).toBe('https://cdn.example.com/spot.mp4')
    expect(video?.hasAttribute('controls')).toBe(true)
    expect(container.textContent).toContain('rawUrl')
  })

  it('renders no gallery when the result has no media URLs', () => {
    const { container } = render(
      <ToolOutput
        output={{ content: [{ type: 'text', text: 'Credits: 10 | Plan: free' }] }}
        resolver={(value) => Promise.resolve(value)}
      />
    )
    expect(container.querySelector('[data-testid="tool-media-gallery"]')).toBeNull()
  })
})
