import { render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import type { ComponentType, ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import {
  DEFAULT_FONT_SIZE,
  XL_FONT_SIZE,
  setFontSize,
  setTheme,
  settle,
  expectNoHorizontalOverflow,
} from '@/test/layout'
import { localStorageKey } from '@/constants/localStorage'
import { Route as Chat } from '@/routes/index'
import { Route as Agent } from '@/routes/agent/index'

vi.mock('@tanstack/react-router', () => ({
  Navigate: () => null,
  redirect: () => ({}),
  createFileRoute: () => (options: unknown) => options,
  useSearch: () => ({}),
}))
vi.mock('@/components/ConversationHeader', () => ({
  default: () => <header className="h-(--page-header-height) shrink-0" />,
}))
vi.mock('@/containers/AgentWorkspaceLayout', () => ({
  AgentWorkspaceLayout: ({ children }: { children: ReactNode }) => (
    <main className="flex h-full w-full">{children}</main>
  ),
}))
vi.mock('@/containers/ChatInput', () => ({
  default: () => <textarea aria-label="Message" className="h-20 w-full" />,
}))
vi.mock('@/containers/TaskComposer', () => ({
  TaskComposer: () => <textarea aria-label="Message" className="h-20 w-full" />,
}))
vi.mock('@/hooks/useThreads', () => {
  const store = { threads: {}, setCurrentThreadId: () => {} }
  return { useThreads: Object.assign(() => store, { getState: () => store }) }
})
vi.mock('@/hooks/useAgentMode', () => ({ useAgentMode: () => undefined }))
vi.mock('@/hooks/useTools', () => ({ useTools: () => {} }))
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({}),
  useServiceHub: () => ({}),
}))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: () => ({ providers: [] }),
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: () => 'How can I help you today?' }),
}))
const ChatPage = (Chat as unknown as { component: ComponentType }).component
const AgentPage = (Agent as unknown as { component: ComponentType }).component

for (const width of [1024, 1280]) {
  for (const font of [DEFAULT_FONT_SIZE, XL_FONT_SIZE]) {
    for (const theme of ['light', 'dark'] as const) {
      it(`keeps the logo and composer aligned when switching at ${width}px, ${font}, ${theme}`, async () => {
        localStorage.setItem(localStorageKey.setupCompleted, 'true')
        await page.viewport(width, 800)
        setTheme(theme)
        setFontSize(font)
        const frame = (Page: ComponentType) => (
          <div style={{ display: 'flex', height: '100vh' }}>
            <aside style={{ width: width < 1052 ? 60 : 300 }} />
            <section className="min-w-0 flex-1" data-testid="main">
              <Page />
            </section>
          </div>
        )
        const view = render(frame(ChatPage))
        const bounds = () =>
          [
            screen.getByRole('img', { name: 'Atomic Chat' }),
            screen.getByRole('heading', { level: 1 }),
            screen.getByRole('textbox'),
          ].map((el) => {
            const { x, y, width, height } = el.getBoundingClientRect()
            return [x, y, width, height].map(Math.round)
          })
        await settle()
        const chat = bounds()
        view.rerender(frame(AgentPage))
        await settle()
        expect(bounds()).toEqual(chat)
        expectNoHorizontalOverflow(screen.getByTestId('main'))
      })
    }
  }
}
