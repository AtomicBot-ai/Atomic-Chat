import { act, fireEvent, render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CSSProperties } from 'react'

import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { useThreads } from '@/hooks/useThreads'
import { useThreadManagementStore } from '@/hooks/useThreadManagement'
import {
  MIN_PAGE_WIDTH,
  NAVIGATION_RAIL_WIDTH,
  WINDOW_TITLEBAR_HEIGHT,
} from '@/lib/navigation'
import type { ThreadFolder } from '@/services/projects/types'
import {
  XL_FONT_SIZE,
  expectNoHorizontalOverflow,
  expectOneLine,
  expectSameHeight,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
} from '@/test/layout'
import { LeftSidebar } from '.'

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params: _params,
    search: _search,
    hash: _hash,
    ...props
  }: {
    children: React.ReactNode
    to: string
    params?: unknown
    search?: unknown
    hash?: string
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useLocation: () => ({ pathname: '/', search: {} }),
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}))

const folders = vi.hoisted<ThreadFolder[]>(() => [])
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ opener: () => ({ open: vi.fn() }) }),
  getServiceHub: () => ({
    projects: () => ({ getProjects: async () => folders }),
  }),
}))

vi.mock('@/hooks/useLocalApiServerControl', () => ({
  useLocalApiServerControl: () => ({
    status: 'stopped',
    isRunning: false,
    isBusy: false,
    start: vi.fn(),
    stop: vi.fn(),
    toggle: vi.fn(),
  }),
}))

vi.mock('@/lib/integration-agent-detection', () => ({
  detectIntegrationAgentsOnce: () => {},
}))

vi.mock('@/containers/dialogs/AddProjectDialog', () => ({
  default: () => null,
}))
vi.mock('@/containers/dialogs/SearchDialog', () => ({
  SearchDialog: () => null,
}))

const RAIL = NAVIGATION_RAIL_WIDTH
const now = Math.floor(Date.now() / 1000)
const HOUR = 3600
const DAY = 24 * HOUR

// The audit's case: two pairs of chats whose titles only part after the
// width the sidebar shows, beside chats whose titles are their own.
const THREADS: Thread[] = [
  {
    id: 'blank-1',
    title: 'generate a blank html page with a header and footer',
    updated: now - 60,
  },
  {
    id: 'blank-2',
    title: 'generate a blank page for my landing site',
    updated: now - 26 * HOUR,
  },
  {
    id: 'html-1',
    title: 'build me a html calculator with history',
    updated: now - 2 * HOUR,
  },
  {
    id: 'html-2',
    title: 'build me a html snake game',
    updated: now - 40 * DAY,
  },
  {
    id: 'long',
    title: 'Explain quantum entanglement simply, with one everyday analogy',
    updated: now - 3 * HOUR,
  },
  { id: 'short', title: 'Hi', updated: now - 4 * HOUR },
  {
    id: 'pinned',
    title: 'Weekly report summary',
    updated: now - 5 * HOUR,
    isFavorite: true,
  },
]

const PROJECTS: ThreadFolder[] = [
  {
    id: 'research-2026',
    name: 'Client research and interviews 2026',
    updated_at: Date.now() - DAY * 1000,
  },
  {
    id: 'research-2025',
    name: 'Client research and interviews 2025',
    updated_at: Date.now() - 300 * DAY * 1000,
  },
  { id: 'misc', name: 'Misc', updated_at: Date.now() },
]

/** A sidebar widened past the default, where a colliding row shows its date. */
const WIDE_SIDEBAR = '20rem'

function Shell({ sidebarWidth }: { sidebarWidth?: string }) {
  return withTranslations(
    <SidebarProvider
      className="app-shell"
      style={
        {
          '--navigation-rail-width': `${RAIL}px`,
          '--window-titlebar-height': `${WINDOW_TITLEBAR_HEIGHT}px`,
        } as CSSProperties
      }
      insetOffset={RAIL}
      minInsetWidth={MIN_PAGE_WIDTH}
      defaultWidth={sidebarWidth}
    >
      <LeftSidebar />
      <SidebarInset>
        <div className="h-svh" />
      </SidebarInset>
    </SidebarProvider>
  )
}

const rowFor = (title: string) =>
  screen.getByText(title).closest('a') as HTMLAnchorElement
const contextOf = (row: HTMLElement) => row.querySelector('time')

beforeEach(() => {
  folders.splice(0, folders.length, ...PROJECTS)
  useThreads.getState().setThreads(THREADS)
  useThreadManagementStore.setState({ folders: PROJECTS })
})

describe.each(['light', 'dark'] as const)(
  'chat and project rows in %s theme',
  (theme) => {
    it.each(
      [1024, 1280].flatMap((width) =>
        ['16px', XL_FONT_SIZE].map((fontSize) => ({ width, fontSize }))
      )
    )(
      'tell colliding names apart in a wide sidebar at $width px / $fontSize',
      async ({ width, fontSize }) => {
        await page.viewport(width, 800)
        setTheme(theme)
        setFontSize(fontSize)
        render(<Shell sidebarWidth={WIDE_SIDEBAR} />)
        await settle()
        if (width === 1024) {
          // No room to dock at 1024 px: open the sidebar over the page.
          fireEvent.click(
            screen.getByRole('button', { name: 'Toggle sidebar' })
          )
          await settle()
        }

        const colliding = [
          ['blank-1', 'blank-2'],
          ['html-1', 'html-2'],
        ].map((pair) =>
          pair.map((id) => rowFor(THREADS.find((t) => t.id === id)!.title))
        )
        for (const [a, b] of colliding) {
          const contextA = contextOf(a)
          const contextB = contextOf(b)
          expect(contextA, a.textContent ?? '').not.toBeNull()
          expect(contextB, b.textContent ?? '').not.toBeNull()
          // The context is what tells the pair apart.
          expect(contextA!.textContent).not.toBe(contextB!.textContent)
          for (const context of [contextA!, contextB!]) {
            expect(context.getBoundingClientRect().width).toBeGreaterThan(0)
            expectOneLine(context)
            // It sits before the row's action column (pin and "…").
            const row = context.closest('a')!.getBoundingClientRect()
            expect(context.getBoundingClientRect().right).toBeLessThanOrEqual(
              row.right - 56 + 1
            )
          }
        }

        // Names of their own carry nothing extra.
        for (const title of [
          THREADS[4].title,
          'Hi',
          'Weekly report summary',
          'Misc',
        ]) {
          expect(contextOf(rowFor(title)), title).toBeNull()
        }

        // Projects whose names collide get the same context.
        const projects = PROJECTS.slice(0, 2).map((p) => rowFor(p.name))
        for (const project of projects) {
          expect(contextOf(project), project.textContent ?? '').not.toBeNull()
          expectOneLine(contextOf(project)!)
        }

        // Every row keeps one height and every name one line.
        const rows = [
          ...THREADS.map((t) => rowFor(t.title)),
          ...PROJECTS.map((p) => rowFor(p.name)),
        ]
        expectSameHeight(rows)
        for (const row of rows) {
          expectOneLine(row.querySelector('.truncate') as HTMLElement)
        }
        const content = document.querySelector(
          '[data-sidebar="content"]'
        ) as HTMLElement
        for (const live of content.querySelectorAll<HTMLElement>(
          '[role="status"][aria-live]'
        )) {
          live.style.display = 'none'
        }
        expectNoHorizontalOverflow(content)
      }
    )
  }
)

describe('a sidebar at its default width', () => {
  it.each(['16px', XL_FONT_SIZE])(
    'leaves a colliding row its whole width and the date to the tooltip (%s)',
    async (fontSize) => {
      await page.viewport(1280, 800)
      setFontSize(fontSize)
      render(<Shell />)
      await settle()

      const row = rowFor(THREADS.find((t) => t.id === 'blank-1')!.title)
      const context = contextOf(row)
      expect(context).not.toBeNull()
      expect(getComputedStyle(context!).display).toBe('none')

      await act(async () => row.focus())
      expect(await screen.findByRole('tooltip')).toHaveTextContent(
        'Last activity:'
      )
    }
  )
})

describe('full names', () => {
  it.each(['16px', XL_FONT_SIZE])(
    'show on keyboard focus when a row cuts the name short (%s)',
    async (fontSize) => {
      await page.viewport(1280, 800)
      setFontSize(fontSize)
      render(<Shell />)
      await settle()

      const long = rowFor(THREADS[4].title)
      await act(async () => long.focus())
      const tooltip = await screen.findByRole('tooltip')
      expect(tooltip).toHaveTextContent(THREADS[4].title)
      expect(tooltip).toHaveTextContent('Last activity:')
      await settle()
      // The bubble wraps a long name inside the window.
      const bubble = document.querySelector(
        '[data-slot="tooltip-content"]'
      ) as HTMLElement
      expect(bubble.getBoundingClientRect().right).toBeLessThanOrEqual(1280)

      // A project's long name too.
      await act(async () => rowFor(PROJECTS[0].name).focus())
      expect(await screen.findByRole('tooltip')).toHaveTextContent(
        PROJECTS[0].name
      )
    }
  )

  it('stay out of the way of names shown in full', async () => {
    await page.viewport(1280, 800)
    render(<Shell />)
    await settle()

    await act(async () => rowFor('Hi').focus())
    await settle()
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})
