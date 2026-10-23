import { render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CSSProperties } from 'react'

import {
  Sidebar,
  SidebarContent,
  SidebarProvider,
} from '@/components/ui/sidebar'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useServerSetup } from '@/hooks/useServerSetup'
import { useOnboardingStore } from '@/stores/onboarding-store'
import {
  XL_FONT_SIZE,
  expectFits,
  expectNoHorizontalOverflow,
  expectOneLine,
  expectVerticallyCentered,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
} from '@/test/layout'

import { ServerControlPanel } from './ServerControlPanel'

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    ...props
  }: {
    children: React.ReactNode
    to: string
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}))

vi.mock('@/hooks/useLocalApiServerControl', () => ({
  useLocalApiServerControl: () => ({
    status: 'running',
    isRunning: true,
    isBusy: false,
    toggle: vi.fn(),
  }),
}))

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (selector: (state: unknown) => unknown) =>
    selector({ getProviderByName: () => undefined }),
}))

// The model of the QA report (2.2.23, finding 07), and a worst-case id.
const GEMMA = 'ggml-org/Gemma-4-E4B-IQ4_XS'
const LONG = 'unsloth/' + 'VeryLongModelName'.repeat(6) + '-Q4_K_M'

/** The card in the real floating sidebar, beside the 60 px rail. */
function Shell({ width }: { width?: string }) {
  return withTranslations(
    <SidebarProvider
      defaultWidth={width}
      style={{ '--navigation-rail-width': '60px' } as CSSProperties}
    >
      <Sidebar variant="floating" collapsible="offcanvas">
        <SidebarContent>
          <ServerControlPanel />
        </SidebarContent>
      </Sidebar>
    </SidebarProvider>
  )
}

function serve(model: string) {
  useLocalApiServer.setState({
    defaultModelLocalApiServer: { model, provider: 'llamacpp-upstream' },
    lastServerModels: [{ model, provider: 'llamacpp-upstream' }],
  })
}

const modelLabel = () => screen.getByText('Model', { selector: 'span' })
const modelRow = () => modelLabel().closest('a') as HTMLElement

beforeEach(() => {
  useServerSetup.setState({ setupDone: true, configuredAgents: [] })
  useOnboardingStore.getState().reset()
})

/** A first run handed off to the endpoint, `title` still downloading. */
function downloading(title: string) {
  useLocalApiServer.setState({
    defaultModelLocalApiServer: null,
    lastServerModels: [],
  })
  const store = useOnboardingStore.getState()
  store.begin('full', 'server')
  store.choose({
    source: 'download',
    provider: 'llamacpp-upstream',
    modelId: title,
    title,
    matchIds: [title],
  })
  store.enqueue({
    key: 'chat',
    kind: 'chat',
    title,
    taskId: title,
    phase: 'running',
  })
  store.handOff('endpoint')
  store.setGuide(null)
}

describe.each(['light', 'dark'] as const)(
  'the Server card in the sidebar, %s theme',
  (theme) => {
    const cases = [1024, 1280].flatMap((width) =>
      ['16px', XL_FONT_SIZE].map((fontSize) => ({ width, fontSize }))
    )

    it.each(cases)(
      'names the served model and its quant on one line, at $width px / $fontSize',
      async ({ width, fontSize }) => {
        await page.viewport(width, 800)
        setTheme(theme)
        setFontSize(fontSize)
        serve(GEMMA)
        render(<Shell />)
        await settle()

        const card = screen.getByRole('region', { name: 'Server' })
        expectNoHorizontalOverflow(card)

        const row = modelRow()
        const name = row.querySelector('strong') as HTMLElement
        // None of the name is clipped, and it is the readable name, not the
        // owner's prefix.
        expect(
          name.scrollWidth,
          `"${name.textContent}" needs ${name.scrollWidth} px and has ${name.clientWidth}`
        ).toBeLessThanOrEqual(name.clientWidth)
        expect(name.textContent).toBe('Gemma 4 E4B')
        expectOneLine(name)

        // The quant follows the name on its line, under the label.
        const quant = row.querySelector('small') as HTMLElement
        expect(quant.textContent).toBe('IQ4_XS')
        expectOneLine(quant)
        expectFits(quant, row)
        expectVerticallyCentered(quant, name)
        expect(quant.getBoundingClientRect().left).toBeGreaterThanOrEqual(
          name.getBoundingClientRect().right
        )
        expect(modelLabel().getBoundingClientRect().bottom).toBeLessThanOrEqual(
          name.getBoundingClientRect().top + 1
        )

        // The engine reads the same way: its label over its value, in the
        // model name's type.
        const engineRow = screen.getByTestId('server-panel-engine')
        const engine = engineRow.querySelector('strong') as HTMLElement
        expect(engine.textContent).toBe('llama.cpp')
        expectOneLine(engine)
        expect(
          screen
            .getByText('Engine', { selector: 'span' })
            .getBoundingClientRect().bottom
        ).toBeLessThanOrEqual(engine.getBoundingClientRect().top + 1)
        expect(getComputedStyle(engine).fontSize).toBe(
          getComputedStyle(name).fontSize
        )
        expect(getComputedStyle(engine).fontWeight).toBe(
          getComputedStyle(name).fontWeight
        )
        expect(engine.getBoundingClientRect().left).toBeCloseTo(
          name.getBoundingClientRect().left,
          0
        )

        // The icon sits at the centre of the label-and-name block.
        expectVerticallyCentered(
          row.querySelector('svg') as SVGElement,
          row.querySelector('.dsc-model-text') as HTMLElement
        )
        expect(row).toHaveAttribute('title', GEMMA)
      }
    )

    it.each(
      cases.flatMap((c) => [
        { ...c, sidebar: undefined, label: 'default' },
        { ...c, sidebar: '14rem', label: 'narrowest' },
      ])
    )(
      "names first-run setup's model while it downloads, the word kept whole, in the $label sidebar, at $width px / $fontSize",
      async ({ width, fontSize, sidebar }) => {
        await page.viewport(width, 800)
        setTheme(theme)
        setFontSize(fontSize)
        downloading('Qwen3.5 4B')
        render(<Shell width={sidebar} />)
        await settle()

        expectNoHorizontalOverflow(
          screen.getByRole('region', { name: 'Server' })
        )
        const row = modelRow()
        const name = row.querySelector('strong') as HTMLElement
        expect(name.textContent).toBe('Qwen3.5 4B')
        expectOneLine(name)
        const note = row.querySelector('small') as HTMLElement
        expect(note.textContent).toBe('Downloading')
        expectOneLine(note)
        expect(note.scrollWidth).toBeLessThanOrEqual(note.clientWidth)
        expectFits(note, row)
        expectVerticallyCentered(note, name)
        // A word in the row's type, not an id in the quant's.
        expect(getComputedStyle(note).fontFamily).toBe(
          getComputedStyle(name).fontFamily
        )
      }
    )

    it.each(
      cases.flatMap((c) => [
        { ...c, sidebar: undefined, label: 'default' },
        { ...c, sidebar: '14rem', label: 'narrowest' },
      ])
    )(
      'truncates a worst-case name at its end in the $label sidebar, at $width px / $fontSize',
      async ({ width, fontSize, sidebar }) => {
        await page.viewport(width, 800)
        setTheme(theme)
        setFontSize(fontSize)
        serve(LONG)
        render(<Shell width={sidebar} />)
        await settle()

        expectNoHorizontalOverflow(
          screen.getByRole('region', { name: 'Server' })
        )
        const row = modelRow()
        const name = row.querySelector('strong') as HTMLElement
        expectOneLine(name)
        expect(getComputedStyle(name).textOverflow).toBe('ellipsis')
        expect(name.textContent?.startsWith('VeryLongModelName')).toBe(true)
        // The quant stays whole however long the name is.
        const quant = row.querySelector('small') as HTMLElement
        expect(quant.textContent).toBe('Q4_K_M')
        expect(quant.scrollWidth).toBeLessThanOrEqual(quant.clientWidth)
        expectFits(quant, row)
      }
    )
  }
)
