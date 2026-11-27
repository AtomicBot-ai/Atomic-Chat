import { fireEvent, render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { expect, it, vi } from 'vitest'
import {
  DEFAULT_FONT_SIZE,
  XL_FONT_SIZE,
  expectNoHorizontalOverflow,
  setFontSize,
  setTheme,
  settle,
} from '@/test/layout'
import ConversationHeader from '@/components/ConversationHeader'

vi.mock('@/constants/integrations', () => ({
  currentDesktopPlatform: () => 'macos',
}))

const navigate = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key.endsWith('chat') ? 'Conversations' : 'Assistant de programmation',
  }),
}))

for (const width of [1000, 1024, 1280]) {
  for (const font of [DEFAULT_FONT_SIZE, XL_FONT_SIZE]) {
    for (const theme of ['light', 'dark'] as const) {
      it(`centers the mode switch at ${width}px, ${font}, ${theme}`, async () => {
        await page.viewport(width, 800)
        setFontSize(font)
        setTheme(theme)
        render(
          <div style={{ display: 'flex', width: '100%' }}>
            <aside style={{ width: width >= 1052 ? 300 : 60 }} />
            <main className="min-w-0 flex-1" data-testid="page">
              <ConversationHeader mode="chat" showModeSwitch />
            </main>
          </div>
        )
        await settle()
        const group = screen.getByRole('group')
        const bounds = group.getBoundingClientRect()
        const pageBounds = screen.getByTestId('page').getBoundingClientRect()
        expect(bounds.left + bounds.width / 2).toBeCloseTo(
          pageBounds.left + pageBounds.width / 2,
          0
        )
        expect(bounds.right).toBeLessThanOrEqual(pageBounds.right)
        expectNoHorizontalOverflow(group)
      })
    }
  }
}

it('switches between the two start pages', () => {
  const { rerender } = render(<ConversationHeader mode="chat" showModeSwitch />)
  const [chat, agent] = screen.getAllByRole('button')
  expect(chat).toHaveAttribute('aria-pressed', 'true')
  fireEvent.click(agent)
  expect(navigate).toHaveBeenLastCalledWith({ to: '/agent' })
  rerender(<ConversationHeader mode="agent" showModeSwitch />)
  expect(agent).toHaveAttribute('aria-pressed', 'true')
  fireEvent.click(chat)
  expect(navigate).toHaveBeenLastCalledWith({ to: '/' })
})

it.each(['chat', 'agent'] as const)(
  'leaves the %s thread header for the title and actions',
  (mode) => {
    render(
      <ConversationHeader mode={mode}>
        <h1>Review</h1>
      </ConversationHeader>
    )
    expect(screen.queryByRole('group')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Review' })).toBeVisible()
  }
)
