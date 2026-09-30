import { act, fireEvent, render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ChatInput from './ChatInput'
import { useAgentRun } from '@/hooks/useAgentRun'
import { useThreads } from '@/hooks/useThreads'
import { usePrompt } from '@/hooks/usePrompt'
import { seedServiceHub } from '@/test/service-hub'
import {
  expectNoHorizontalOverflow,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
} from '@/test/layout'

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
vi.mock('@/containers/DropdownModelProvider', () => ({ default: () => null }))
vi.mock('@/containers/DropdownPlugins', () => ({ default: () => null }))
vi.mock('@/containers/VoiceInputToggle', () => ({ default: () => null }))
vi.mock('@/containers/ReplyModelGate', () => ({ ReplyModelGate: () => null }))
vi.mock('@/containers/AgentExternalFolderButton', () => ({
  AgentExternalFolderButton: () => null,
}))
vi.mock('@/components/TokenCounter', () => ({ TokenCounter: () => null }))

const THREAD = 'approval-layout'
const longPath = '/Users/danny/Documents/' + 'long-project-folder/'.repeat(16)
function request(kind: 'folder' | 'tool') {
  useAgentRun.getState().applyEvent(
    THREAD,
    kind === 'folder'
      ? {
          type: 'folder_access_requested',
          run_id: 'run-1',
          access_id: 'access-1',
          tool: 'os.fs.read',
          path: longPath,
          display_name: 'project',
          root_id: 'root-1',
          reason: 'outside the workspace',
        }
      : {
          type: 'approval_requested',
          run_id: 'run-1',
          approval_id: 'approval-1',
          tool: 'mcp.github.' + 'long_tool_name_'.repeat(12),
          reason: 'Review this change before continuing.',
          preview: { path: longPath },
          affected_resources: [
            { kind: 'file', value: longPath, operation: 'write' },
          ],
          can_remember: true,
        }
  )
}

beforeEach(() => {
  seedServiceHub()
  useAgentRun.getState().clearAll()
  useAgentRun.getState().startRun(THREAD, 'run-1')
  useThreads.setState({ currentThreadId: THREAD })
  usePrompt.setState({ prompt: 'Keep this draft in place.' })
})

const cases = [360, 1024, 1280].flatMap((width) =>
  ['16px', '20px'].flatMap((fontSize) =>
    (['light', 'dark'] as const).flatMap((theme) =>
      (['folder', 'tool'] as const).map((kind) => ({
        width,
        fontSize,
        theme,
        kind,
      }))
    )
  )
)

describe('Approval/composer stack geometry (Chromium)', () => {
  it.each(cases)(
    '$width / $fontSize / $theme / $kind',
    async ({ width, fontSize, theme, kind }) => {
      await page.viewport(width, 800)
      setFontSize(fontSize)
      setTheme(theme)
      render(
        withTranslations(
          <div style={{ marginLeft: width >= 1024 ? 256 : 0, padding: 16 }}>
            <div data-testid="conversation" style={{ height: 560 }}>
              Earlier conversation
            </div>
            <ChatInput chatStatus="submitted" />
          </div>
        )
      )
      await settle()
      const input = screen.getByTestId('chat-input')
      const composer = input.closest<HTMLElement>('.border-input')!
      const before = composer.getBoundingClientRect()
      const history = screen.getByTestId('conversation').getBoundingClientRect()
      await act(async () => request(kind))
      await settle()
      const card = screen.getByTestId('agent-approval-inline')
      const checkGeometry = () => {
        const a = card.getBoundingClientRect()
        const c = composer.getBoundingClientRect()
        expect(a.left, 'approval left edge').toBeCloseTo(c.left, 1)
        expect(a.right, 'approval right edge').toBeCloseTo(c.right, 1)
        expect(a.bottom, 'shared seam without gap or overlap').toBeCloseTo(
          c.top,
          1
        )
        expect(c.top, 'composer must not jump').toBeCloseTo(before.top, 1)
        expect(input.getBoundingClientRect().top).toBeGreaterThanOrEqual(
          a.bottom
        )
        expect(a.top, 'approval stays inside viewport').toBeGreaterThanOrEqual(
          0
        )
        expect(
          screen.getByTestId('conversation').getBoundingClientRect().bottom
        ).toBe(history.bottom)
        expectNoHorizontalOverflow(card)
        const style = getComputedStyle(card)
        expect(style.backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
        expect(style.backgroundColor).not.toBe('rgb(255, 255, 255)')
        expect(style.backgroundColor).not.toContain(' / ')
        expect(style.borderLeftColor).toBe(
          getComputedStyle(composer).borderLeftColor
        )
        expect(style.borderTopLeftRadius).toBe(
          getComputedStyle(composer).borderBottomLeftRadius
        )
        expect(getComputedStyle(composer).borderTopLeftRadius).toBe('0px')
        expect(getComputedStyle(card.parentElement!).opacity).toBe('1')
        // The action row stays on one line whenever its labels fit.
        const actions = [
          ...card.querySelectorAll<HTMLButtonElement>('[data-slot=button]'),
        ]
        const widths = actions.reduce(
          (sum, button) => sum + button.getBoundingClientRect().width,
          0
        )
        const available = actions[0].parentElement!.clientWidth
        if (widths + (actions.length - 1) * 8 <= available) {
          for (const action of actions) {
            expect(action.getBoundingClientRect().top).toBe(
              actions[0].getBoundingClientRect().top
            )
          }
        }
        const button = card.querySelector('button')!
        const b = button.getBoundingClientRect()
        expect(
          card.contains(
            document.elementFromPoint(
              b.left + b.width / 2,
              b.top + b.height / 2
            )
          )
        ).toBe(true)
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width)
      }
      checkGeometry()
      if (kind === 'tool') {
        fireEvent.click(screen.getByRole('button', { name: 'Show details' }))
        await settle()
        checkGeometry()
      }
      await act(async () => useAgentRun.getState().clearAll())
      await settle()
      expect(screen.queryByTestId('agent-approval-inline')).toBeNull()
      expect(composer.getBoundingClientRect().top).toBeCloseTo(before.top, 1)
      expect(input).toHaveValue('Keep this draft in place.')
    }
  )
})
