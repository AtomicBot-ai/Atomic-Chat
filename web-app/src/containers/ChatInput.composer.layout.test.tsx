import { act, fireEvent, render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChatInput from './ChatInput'
import { useThreads } from '@/hooks/useThreads'
import { usePrompt } from '@/hooks/usePrompt'
import { seedServiceHub } from '@/test/service-hub'
import {
  expectNoHorizontalOverflow,
  expectOneLine,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
  XL_FONT_SIZE,
} from '@/test/layout'

// motion reads the media query once per page, so the preference is stubbed.
const motionPrefs = vi.hoisted(() => ({ reduced: false }))
vi.mock('motion/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('motion/react')>()),
  useReducedMotion: () => motionPrefs.reduced,
}))
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useRouter: () => ({ navigate: vi.fn() }),
}))
vi.mock('@/hooks/useTools', () => ({ useTools: vi.fn() }))
vi.mock('@/hooks/useAgentSkills', () => ({
  useAgentSkills: () => ({ skills: [], loading: false, setEnabled: vi.fn() }),
}))
vi.mock('@/containers/chatInput/useTauriDragDrop', () => ({
  useTauriDragDrop: vi.fn(),
}))
vi.mock('@/lib/extension', () => ({
  ExtensionManager: { getInstance: () => ({ get: () => undefined }) },
}))
// A model pill as wide as the real shell, named or folded down to its mark,
// and a microphone of the real toggle's size: the reveal is measured against
// its neighbours.
vi.mock('@/containers/DropdownModelProvider', () => ({
  default: ({
    className,
    compact,
  }: {
    className?: string
    compact?: boolean
  }) => (
    <button
      data-testid="model-pill"
      data-compact={compact ? 'true' : 'false'}
      className={className}
      style={{
        width: compact ? '5rem' : '10.5rem',
        height: 28,
        flexShrink: 0,
        overflow: 'hidden',
        whiteSpace: 'nowrap',
      }}
    >
      {compact ? null : 'Qwen3.5 35B A3B Instruct'}
    </button>
  ),
}))
vi.mock('@/containers/VoiceInputToggle', () => ({
  default: ({ className }: { className?: string }) => (
    <button
      data-testid="voice-toggle"
      className={className}
      style={{ width: 24, height: 24, flexShrink: 0 }}
    />
  ),
}))
vi.mock('@/containers/DropdownPlugins', () => ({ default: () => null }))
vi.mock('@/containers/ReplyModelGate', () => ({ ReplyModelGate: () => null }))
vi.mock('@/components/TokenCounter', () => ({ TokenCounter: () => null }))

const nextFrames = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  )
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  seedServiceHub()
  motionPrefs.reduced = false
  useThreads.setState({ currentThreadId: undefined })
  usePrompt.setState({ prompt: '' })
})

afterEach(async () => {
  await page.viewport(1280, 800)
})

function renderComposer(width: number) {
  return render(
    withTranslations(
      <div className="app-shell">
        <div style={{ marginLeft: width >= 1024 ? 304 : 0, padding: 16 }}>
          <ChatInput />
        </div>
      </div>
    )
  )
}

const typeMessage = (value: string) =>
  act(async () => {
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value } })
  })

const cases = [1280, 1024, 360].flatMap((width) =>
  ['16px', XL_FONT_SIZE].flatMap((fontSize) =>
    (['light', 'dark'] as const).map((theme) => ({ width, fontSize, theme }))
  )
)

describe('Composer toolbar and Send reveal (Chromium)', () => {
  it.each(cases)(
    '$width / $fontSize / $theme',
    async ({ width, fontSize, theme }) => {
      await page.viewport(width, 800)
      setFontSize(fontSize)
      setTheme(theme)
      motionPrefs.reduced = true
      renderComposer(width)
      await settle()

      const composer = screen
        .getByTestId('chat-input')
        .closest<HTMLElement>('.border-input')!
      const attach = screen.getByTestId('composer-attach')
      const access = screen.getByRole('button', { name: 'Restricted' })
      const pill = screen.getByTestId('model-pill')

      // An empty composer has no Send, and nothing spills sideways.
      expect(screen.queryByTestId('send-control')).toBeNull()
      expectNoHorizontalOverflow(composer)
      // The paperclip is the regular round 36px action.
      const a = attach.getBoundingClientRect()
      expect(a.width).toBeCloseTo(36, 0)
      expect(a.height).toBeCloseTo(36, 0)
      // The access label reads in full on one line, compact composer too.
      expectOneLine(access.querySelector('span')!)
      expect(access.getBoundingClientRect().right).toBeLessThanOrEqual(
        composer.getBoundingClientRect().right
      )
      const pillBefore = pill.getBoundingClientRect()

      await typeMessage('Hello there')
      await settle()
      await nextFrames()

      // Send sits at the right edge, whole and round, and the pill moved
      // aside by exactly its slot.
      const control = screen.getByTestId('send-control')
      const send = control.querySelector('button')!
      const s = send.getBoundingClientRect()
      const c = composer.getBoundingClientRect()
      expect(s.width).toBeCloseTo(36, 0)
      expect(s.height).toBeCloseTo(36, 0)
      expect(s.right).toBeLessThanOrEqual(c.right)
      expect(s.left).toBeGreaterThanOrEqual(pill.getBoundingClientRect().right)
      const slot =
        control.getBoundingClientRect().width +
        parseFloat(getComputedStyle(control).marginLeft)
      expect(pillBefore.left - pill.getBoundingClientRect().left).toBeCloseTo(
        slot,
        0
      )
      // Settled, the wrapper no longer clips: a focus ring shows whole.
      expect(getComputedStyle(control).overflow).toBe('visible')
      expectNoHorizontalOverflow(composer)
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width)

      // Emptied again, Send leaves and the pill returns.
      await typeMessage('')
      await settle()
      await nextFrames()
      expect(screen.queryByTestId('send-control')).toBeNull()
      expect(pill.getBoundingClientRect().left).toBeCloseTo(pillBefore.left, 0)
    }
  )

  // QA on 2.2.21: the New Chat composer at a 1024 px window, and the one
  // beside open Run settings at 1228 px, folded the pill down to its mark with
  // most of the toolbar empty. The widths are the composer's own there.
  it.each(
    [
      { viewport: 1024, composer: 560 },
      { viewport: 1228, composer: 531 },
    ].flatMap((size) =>
      ['16px', XL_FONT_SIZE].map((fontSize) => ({ ...size, fontSize }))
    )
  )(
    'names the model while the toolbar has room: $composer px composer / $fontSize',
    async ({ viewport, composer: width, fontSize }) => {
      await page.viewport(viewport, 800)
      setFontSize(fontSize)
      motionPrefs.reduced = true
      render(
        withTranslations(
          <div className="app-shell">
            <div style={{ width }}>
              <ChatInput />
            </div>
          </div>
        )
      )
      await settle()

      const composer = screen
        .getByTestId('chat-input')
        .closest<HTMLElement>('.border-input')!
      const pill = screen.getByTestId('model-pill')
      const access = screen.getByRole('button', { name: 'Restricted' })

      expect(pill).toHaveAttribute('data-compact', 'false')
      expect(pill).toHaveTextContent('Qwen3.5 35B A3B Instruct')
      expect(pill.getBoundingClientRect().width).toBeCloseTo(168, 0)
      expect(access.getBoundingClientRect().right).toBeLessThanOrEqual(
        pill.getBoundingClientRect().left
      )
      expectNoHorizontalOverflow(composer)
    }
  )

  it('folds the pill down only when the full pill would not fit', async () => {
    await page.viewport(360, 800)
    motionPrefs.reduced = true
    renderComposer(360)
    await settle()

    const pill = screen.getByTestId('model-pill')
    const access = screen.getByRole('button', { name: 'Restricted' })
    expect(pill).toHaveAttribute('data-compact', 'true')
    // Unfolding would push the pill 88 px into the controls on its left.
    expect(
      pill.getBoundingClientRect().left - access.getBoundingClientRect().right
    ).toBeLessThan(88)
  })

  it('folds and unfolds the pill as the composer narrows and widens', async () => {
    await page.viewport(1024, 800)
    motionPrefs.reduced = true
    render(
      withTranslations(
        <div className="app-shell">
          <div data-testid="composer-column" style={{ width: 560 }}>
            <ChatInput />
          </div>
        </div>
      )
    )
    await settle()
    const column = screen.getByTestId('composer-column')
    const pill = screen.getByTestId('model-pill')
    const resizeTo = async (width: number) => {
      column.style.width = `${width}px`
      await nextFrames()
      await nextFrames()
    }

    expect(pill).toHaveAttribute('data-compact', 'false')
    await resizeTo(300)
    expect(pill).toHaveAttribute('data-compact', 'true')
    await resizeTo(560)
    expect(pill).toHaveAttribute('data-compact', 'false')
    expect(pill.getBoundingClientRect().width).toBeCloseTo(168, 0)
  })

  it('grows Send in from nothing over a quarter second', async () => {
    renderComposer(1280)
    await settle()

    await typeMessage('Hello there')
    await nextFrames()
    const control = screen.getByTestId('send-control')
    const early = control.getBoundingClientRect().width
    expect(early).toBeLessThan(40)
    expect(getComputedStyle(control).overflow).toBe('hidden')

    await wait(400)
    expect(control.getBoundingClientRect().width).toBeCloseTo(40, 0)
    expect(getComputedStyle(control).overflow).toBe('visible')
  })

  it('shows Send at full size at once with reduced motion', async () => {
    motionPrefs.reduced = true
    renderComposer(1280)
    await settle()

    await typeMessage('Hello there')
    await nextFrames()
    expect(
      screen.getByTestId('send-control').getBoundingClientRect().width
    ).toBeCloseTo(40, 0)
  })
})
