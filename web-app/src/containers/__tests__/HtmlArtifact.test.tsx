import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

vi.mock('@janhq/core', () => ({ fs: { writeFileSync: vi.fn() } }))

vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({ dialog: () => ({ save: vi.fn() }) }),
}))

vi.mock('@/lib/platform/utils', () => ({ isPlatformTauri: () => false }))

vi.mock('@/components/ai-elements/code-block', () => ({
  CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>,
}))

import { HtmlArtifact } from '../HtmlArtifact'

const SCROLL_HEIGHT = 1200

const codePane = () =>
  document.querySelector<HTMLElement>('[data-artifact-pane="code"]')!
const previewPane = () =>
  document.querySelector<HTMLElement>('[data-artifact-pane="preview"]')!

describe('HtmlArtifact', () => {
  let scrollTops: number[]

  beforeEach(() => {
    scrollTops = []
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get: () => 0,
      set(value: number) {
        scrollTops.push(value)
      },
    })
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => SCROLL_HEIGHT,
    })
  })

  afterEach(() => {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)
      .scrollTop
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)
      .scrollHeight
  })

  it('shows the streaming code instead of an unrenderable preview', () => {
    render(<HtmlArtifact code="<div>partial" streaming />)

    expect(codePane().className).not.toContain('hidden')
    expect(previewPane().className).toContain('hidden')
    expect(codePane().textContent).toContain('workspacePreview.generating')
    expect(document.querySelector('iframe')).not.toHaveAttribute('src')
  })

  it('follows the tail of the code while it streams in', () => {
    const { rerender } = render(<HtmlArtifact code="<div>" streaming />)
    scrollTops.length = 0

    rerender(<HtmlArtifact code="<div>more markup" streaming />)

    expect(scrollTops).toContain(SCROLL_HEIGHT)
  })

  it('stops following once the reader scrolls away from the tail', () => {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => 400,
    })
    const { rerender } = render(<HtmlArtifact code="<div>" streaming />)

    // scrollTop reads as 0, so the gap to the tail is larger than the threshold.
    codePane()
      .querySelector('.overflow-y-auto')!
      .dispatchEvent(new Event('scroll'))
    scrollTops.length = 0
    rerender(<HtmlArtifact code="<div>more markup" streaming />)

    expect(scrollTops).toHaveLength(0)
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)
      .clientHeight
  })

  it('hands the viewer back to the preview once generation settles', () => {
    const { rerender } = render(<HtmlArtifact code="<div>done</div>" streaming />)

    rerender(<HtmlArtifact code="<div>done</div>" />)

    expect(previewPane().className).not.toContain('hidden')
    expect(codePane().className).toContain('hidden')
    expect(codePane().textContent).not.toContain('workspacePreview.generating')
  })

  it('keeps the preview visible for a settled artifact', () => {
    render(<HtmlArtifact code="<div>done</div>" />)

    expect(previewPane().className).not.toContain('hidden')
    expect(codePane().className).toContain('hidden')
  })
})
