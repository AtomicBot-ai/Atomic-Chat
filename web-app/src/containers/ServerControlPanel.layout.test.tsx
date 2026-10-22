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
const MUSE = 'AtomicChat/Muse-Glimmer-30B-AD-IQ4_XS'
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
})

describe.each(['light', 'dark'] as const)(
  'the Server card in the sidebar, %s theme',
  (theme) => {
    const cases = [1024, 1280].flatMap((width) =>
      ['16px', XL_FONT_SIZE].map((fontSize) => ({ width, fontSize }))
    )

    it.each(cases)(
      'names the served model whole, its quant apart, at $width px / $fontSize',
      async ({ width, fontSize }) => {
        await page.viewport(width, 800)
        setTheme(theme)
        setFontSize(fontSize)
        serve(MUSE)
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
        expect(name.textContent).toBe('Muse Glimmer 30B AD')
        expectOneLine(name)

        // The quant is a small meta beside the label, inside the row.
        const quant = row.querySelector('small') as HTMLElement
        expect(quant.textContent).toBe('IQ4_XS')
        expectOneLine(quant)
        expectFits(quant, row)
        expectVerticallyCentered(quant, modelLabel())

        // The icon sits at the centre of the label-and-name block.
        expectVerticallyCentered(
          row.querySelector('svg') as SVGElement,
          row.querySelector('.dsc-model-text') as HTMLElement
        )
        expect(row).toHaveAttribute('title', MUSE)
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
