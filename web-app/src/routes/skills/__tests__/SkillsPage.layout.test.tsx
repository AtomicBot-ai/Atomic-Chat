import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentSkillDetail } from '@/services/agent/skills'
import {
  DEFAULT_FONT_SIZE,
  expectFits,
  expectNoHorizontalOverflow,
  expectOneLine,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
  XL_FONT_SIZE,
} from '@/test/layout'

import { SkillsPage } from '../index'

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: unknown) => config,
  useNavigate: () => vi.fn(),
}))

const serviceHubStub = { dialog: () => ({ open: vi.fn(), save: vi.fn() }) }
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => serviceHubStub,
  getServiceHub: () => serviceHubStub,
}))

const fixture = vi.hoisted(() => ({
  skills: [] as AgentSkillDetail[],
  selected: null as AgentSkillDetail | null,
}))

// The real hook talks to Tauri; this one keeps its selection in React state,
// so opening a row loads that skill exactly as the page sees it at runtime.
vi.mock('@/hooks/useAgentSkills', async () => {
  const { useState } = await import('react')
  return {
    useAgentSkills: () => {
      const [selected, setSelected] = useState(fixture.selected)
      return {
        skills: fixture.skills,
        selected,
        loading: false,
        error: null,
        load: vi.fn(),
        select: async (name: string) =>
          setSelected(fixture.skills.find((s) => s.name === name) ?? null),
        setEnabled: vi.fn(),
        addCreated: vi.fn(),
        addImported: vi.fn(),
        remove: vi.fn(),
        update: vi.fn(),
        exportSkill: vi.fn(),
      }
    },
  }
})

/** The bundled apple-calendar instructions the audit read, trimmed. */
const APPLE_CALENDAR_BODY = `# apple-calendar

Read Apple Calendar from the terminal via [\`icalBuddy\`](https://hasseg.org/icalBuddy/)
(read-only) and create events through \`osascript\` AppleScript against Calendar.app.

## Setup check (lazy — do NOT probe every turn)

Do **not** run a \`--version\` probe before each request. Just run the
calendar command the user asked for (e.g. \`icalBuddy eventsToday\`) directly.

- stderr mentions \`command not found: icalBuddy\` → **Setup playbook → "icalBuddy is not installed"**.
- a read returns nothing and stderr mentions calendar access / not authorized → **Setup playbook → "Calendar permission missing"**.

### Calendar permission missing

\`\`\`
[{ "tool": "os.shell.run", "args": { "cmd": "open", "args": ["x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars"] } }]
\`\`\`

> "I opened the right panel. Find your terminal program or \`atomic-agent\` there and enable the checkbox next to Calendars."

## Reading events (icalBuddy)

| Goal | args |
|---|---|
| Today's events | \`["eventsToday"]\` |
| Specific range | \`["-sd", "eventsFrom:2026-06-01", "to:2026-06-07"]\` |
| Include only props you need | \`["-iep", "title,datetime,location", "eventsToday"]\` |

Useful global flags: \`-b ""\` (no bullet), \`-nc\` (no calendar name),
\`-df "%Y-%m-%d"\` / \`-tf "%H:%M"\` (date/time formats), \`-n\` (events after now only).
`

/** Instructions whose table cannot fit the pane: it must scroll in its own box. */
const WIDE_TABLE_BODY = `# Wide reference

| Command line flag | Long description of the option | Default value | Accepted values | Platform | Since version | Notes |
|---|---|---|---|---|---|---|
| \`--include-event-properties\` | Only print these properties | all | title, datetime, location | macOS | 1.8.0 | Comma separated |
`

const skill = (
  name: string,
  description: string,
  body = '',
  reserved = true
): AgentSkillDetail => ({
  name,
  description,
  version: '1.0.0',
  requiresTools: ['os.shell.run'],
  requiresScripts: [],
  dangerous: false,
  platforms: null,
  enabled: true,
  compatible: true,
  reserved,
  unavailableReasons: [],
  error: null,
  body,
})

const appleCalendar = skill(
  'apple-calendar',
  "Read macOS Calendar events via the `icalBuddy` CLI and create events via AppleScript (osascript). Use to check the user's calendar, agenda, upcoming events, or add an event on macOS.",
  APPLE_CALENDAR_BODY
)
const wideTable = skill(
  'weekly-status-report-for-the-platform-team-and-leadership',
  'Generate weekly status reports from recent work. Use when asked for updates or progress summaries.',
  WIDE_TABLE_BODY,
  false
)

/** Where the page has to stack: the instructions would get less than 36em. */
const CASES = [
  { width: 1024, fontSize: DEFAULT_FONT_SIZE, theme: 'light', stacked: true },
  { width: 1024, fontSize: XL_FONT_SIZE, theme: 'dark', stacked: true },
  { width: 1280, fontSize: DEFAULT_FONT_SIZE, theme: 'light', stacked: false },
  { width: 1280, fontSize: XL_FONT_SIZE, theme: 'dark', stacked: true },
] as const

/** The page in the app's column: beside the 60 px rail and 256 px sidebar. */
async function renderPage() {
  const view = render(
    withTranslations(
      <div className="flex h-[800px] w-full overflow-hidden">
        <aside className="w-[316px] shrink-0">Sidebar</aside>
        <main data-testid="page" className="min-w-0 flex-1">
          <SkillsPage />
        </main>
      </div>
    )
  )
  await act(async () => {
    await settle(view.container)
  })
  return screen.getByTestId('page')
}

/** Open a skill from the list and wait for its instructions to render. */
async function openSkill(root: HTMLElement, name: string) {
  fireEvent.click(screen.getByText(name, { selector: 'button span' }))
  await waitFor(() => expect(root.querySelector('.markdown h1')).not.toBeNull())
  await act(async () => {
    await settle(root)
  })
}

/** A list row: the name button with its switch and actions menu. */
function rowOf(name: string): HTMLElement {
  return screen.getByText(name, { selector: 'button span' }).closest('button')!
    .parentElement!
}

function rowNames(): string[] {
  return screen
    .queryAllByRole('button')
    .map((button) => button.querySelector('span.truncate')?.textContent)
    .filter((name): name is string => Boolean(name))
}

/** Fenced code highlights lazily; measure once its block has rendered. */
async function waitForCode(root: HTMLElement) {
  await waitFor(() =>
    expect(
      root.querySelector('.markdown [data-streamdown="code-block-body"] code')
    ).not.toBeNull()
  )
  await act(async () => {
    await settle(root)
  })
}

function instructions(root: HTMLElement): HTMLElement {
  return root.querySelector<HTMLElement>('.markdown')!
}

function px(value: string, fontSize: number): number {
  const number = parseFloat(value)
  // A unitless line-height may come back as the multiplier itself.
  return number < 4 ? number * fontSize : number
}

/**
 * The instructions read like a document: at least a 36em line of their own
 * body text, headings scaled for a pane (h1 ≤ 1.5×, h2 ≤ 1.35× the body)
 * and no heading broken over more than two lines.
 */
function expectReadable(markdown: HTMLElement) {
  const body = parseFloat(getComputedStyle(markdown).fontSize)
  const width = markdown.getBoundingClientRect().width
  expect(
    width,
    `instructions are ${width} px wide at ${body} px text (36em = ${36 * body} px)`
  ).toBeGreaterThanOrEqual(36 * body)

  for (const [selector, ratio] of [
    ['h1', 1.5],
    ['h2', 1.35],
  ] as const) {
    for (const heading of markdown.querySelectorAll<HTMLElement>(selector)) {
      const style = getComputedStyle(heading)
      const size = parseFloat(style.fontSize)
      expect(size, `${selector} "${heading.textContent}"`).toBeLessThanOrEqual(
        body * ratio + 0.5
      )
      expect(
        heading.getBoundingClientRect().height,
        `${selector} "${heading.textContent}" wraps past two lines`
      ).toBeLessThanOrEqual(2 * px(style.lineHeight, size) + 1)
    }
  }
}

describe('Skills page geometry', () => {
  beforeEach(() => {
    fixture.skills = [wideTable, appleCalendar]
    fixture.selected = appleCalendar
  })

  it.each(CASES)(
    'gives the instructions a reading width at $width px / $fontSize / $theme',
    async ({ width, fontSize, theme, stacked }) => {
      await page.viewport(width, 800)
      setTheme(theme)
      setFontSize(fontSize)
      const root = await renderPage()
      expectNoHorizontalOverflow(root)

      const rows = fixture.skills.map((s) => rowOf(s.name))
      for (const row of rows) expectOneLine(row.querySelector('span')!)

      if (!stacked) {
        // Side by side: the selected skill's instructions are already open.
        await waitForCode(root)
        expectReadable(instructions(root))
        expectNoHorizontalOverflow(root)
        return
      }

      // Stacked: the list fills the page, so descriptions get its width ...
      expect(root.querySelector('.markdown')).toBeNull()
      const pageWidth = root.getBoundingClientRect().width
      for (const row of rows) {
        expect(row.getBoundingClientRect().width).toBeGreaterThanOrEqual(
          pageWidth - 2 * 12 - 1
        )
      }

      // ... and a skill opens full-width with its controls in the header.
      await openSkill(root, 'apple-calendar')
      await waitForCode(root)
      expect(rowNames()).toEqual([])
      const back = screen.getByRole('button', { name: 'Back to skills' })
      const header = back.parentElement!
      const name = screen.getByText('apple-calendar', {
        selector: 'span[title]',
      })
      expectOneLine(name)
      for (const control of [
        back,
        name,
        screen.getByRole('switch', { name: 'Enable skill' }),
        screen.getByRole('button', { name: 'Skill actions' }),
      ]) {
        expectFits(control, header)
      }
      expectReadable(instructions(root))
      expectNoHorizontalOverflow(root)

      fireEvent.click(back)
      await act(async () => {
        await settle(root)
      })
      expect(root.querySelector('.markdown')).toBeNull()
      expect(rowNames()).toEqual(fixture.skills.map((s) => s.name))
    }
  )

  it('stacks when the interface font grows while the page is open', async () => {
    await page.viewport(1280, 800)
    const root = await renderPage()
    await waitForCode(root)
    expectReadable(instructions(root))

    // Settings → Interface → Extra Large, with Skills still mounted.
    await act(async () => {
      setFontSize(XL_FONT_SIZE)
      await settle(root)
    })

    expect(root.querySelector('.markdown')).toBeNull()
    const pageWidth = root.getBoundingClientRect().width
    for (const skill of fixture.skills) {
      expect(
        rowOf(skill.name).getBoundingClientRect().width
      ).toBeGreaterThanOrEqual(pageWidth - 2 * 12 - 1)
    }
    expectNoHorizontalOverflow(root)
  })

  it.each(CASES.filter((c) => c.stacked))(
    'scrolls a wide table inside its own box at $width px / $fontSize / $theme',
    async ({ width, fontSize, theme }) => {
      await page.viewport(width, 800)
      setTheme(theme)
      setFontSize(fontSize)
      const root = await renderPage()
      await openSkill(root, wideTable.name)

      // The long custom name truncates beside the switch and the menu.
      const name = screen.getByText(wideTable.name, { selector: 'span[title]' })
      expectOneLine(name)
      expectFits(
        screen.getByRole('button', { name: 'Skill actions' }),
        name.parentElement!
      )

      const table = root.querySelector('table')!
      const scroller = table.parentElement!
      // The case is real: the table is wider than the pane ...
      expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth)
      // ... yet only its own box scrolls; the pane and page do not.
      const pane = scroller.closest<HTMLElement>('.overflow-y-auto')!
      expectFits(scroller, pane)
      expect(pane.scrollWidth).toBeLessThanOrEqual(pane.clientWidth + 1)
      expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth + 1)
    }
  )
})
