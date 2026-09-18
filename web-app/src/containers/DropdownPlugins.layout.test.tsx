import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { page, userEvent } from '@vitest/browser/context'

import DropdownPlugins from './DropdownPlugins'
import ProvidersAvatar from './ProvidersAvatar'
import { useAppState } from '@/hooks/useAppState'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useMCPServers } from '@/hooks/useMCPServers'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import { seedServiceHub } from '@/test/service-hub'
import {
  expectNoHorizontalOverflow,
  expectVerticallyCentered,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
} from '@/test/layout'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@/hooks/useThreads', () => ({
  useThreads: () => ({ getCurrentThread: () => undefined }),
}))
vi.mock('@/hooks/useMCPServerStatuses', () => ({
  useMCPServerStatuses: () => ({ statusByName: new Map() }),
}))

// Keep the real dropdown, connector icons and images. Only backend state is
// supplied here; Chromium measures the same clipping layers the menu ships.
describe('Plugins connector icon geometry', () => {
  beforeEach(() => {
    seedServiceHub({})
    useAppState.setState({ tools: [] })
    useGeneralSetting.setState({ agentModeEnabled: false })
    useToolAvailable.setState({
      defaultMutedServers: [],
      defaultDisabledTools: [],
    })
    useMCPServers.setState({
      mcpServers: {
        'exa': { command: '', args: [], env: {}, active: true },
        'notion': { command: '', args: [], env: {}, active: false },
        'my-tools': { command: 'npx', args: [], env: {}, active: false },
      },
    })
  })

  for (const width of [1024, 1280]) {
    for (const font of ['16px', '20px']) {
      for (const theme of ['light', 'dark'] as const) {
        it(`${width}px / ${font} / ${theme}: keeps connector tiles square with modest corners`, async () => {
          await page.viewport(width, 800)
          setFontSize(font)
          setTheme(theme)
          render(
            withTranslations(
              <div className="flex h-screen">
                <aside className="w-64 shrink-0" aria-label="Sidebar" />
                <main className="flex min-w-0 flex-1 items-end justify-end p-4">
                  <div data-testid="model-avatar">
                    <ProvidersAvatar
                      provider={{ provider: 'openai' } as ProviderObject}
                      className="size-8"
                    />
                  </div>
                  <DropdownPlugins initialMessage>
                    {() => <button>Plugins</button>}
                  </DropdownPlugins>
                </main>
              </div>
            )
          )
          await act(async () => {
            await userEvent.click(
              screen.getByRole('button', { name: 'Plugins' })
            )
          })
          const menu = await screen.findByRole('menu')
          await act(async () => {
            await settle()
          })

          expect(menu).toHaveClass('w-72', 'min-w-72')
          const scroller = menu.querySelector<HTMLElement>('.max-h-72')!
          expect(scroller).toHaveClass(
            'overflow-y-auto',
            'overflow-x-hidden',
            '[scrollbar-gutter:stable]'
          )

          for (const key of ['exa', 'notion', 'my-tools']) {
            const slot = screen.getByTestId(`connector-mark-${key}`)
            const tile = slot.firstElementChild!
            for (const layer of [slot, tile]) {
              const box = layer.getBoundingClientRect()
              expect(box.width).toBeCloseTo(32, 1)
              expect(box.height).toBeCloseTo(32, 1)
              const style = getComputedStyle(layer)
              expect(style.overflow).toBe('hidden')
              for (const radius of [
                style.borderTopLeftRadius,
                style.borderTopRightRadius,
                style.borderBottomLeftRadius,
                style.borderBottomRightRadius,
              ]) {
                expect(parseFloat(radius)).toBe(8)
                expect(parseFloat(radius)).toBeLessThan(box.width / 2)
              }
            }
            expectVerticallyCentered(slot, slot.nextElementSibling!)
          }

          for (const [key, background] of [
            ['exa', 'rgb(23, 65, 246)'],
            ['notion', 'rgb(255, 255, 255)'],
          ]) {
            const tile = screen.getByTestId(
              `connector-mark-${key}`
            ).firstElementChild!
            expect(getComputedStyle(tile).backgroundColor).toBe(background)
            const logo = tile.querySelector('img')!
            await logo.decode()
            expect(logo.getAttribute('src')).toBe(
              `/images/connectors/${key}.svg`
            )
            expect(getComputedStyle(logo).objectFit).toBe('contain')
            expect(logo.naturalWidth).toBeGreaterThan(0)
            expect(logo.getBoundingClientRect().width).toBe(32)
            expect(logo.getBoundingClientRect().height).toBe(32)
          }
          expect(
            screen.getByTestId('connector-mark-my-tools').textContent
          ).toBe('m')
          // Circular model/provider avatars still use their existing shape.
          const avatar = screen.getByTestId('model-avatar').firstElementChild!
          expect(
            parseFloat(getComputedStyle(avatar).borderTopLeftRadius)
          ).toBeGreaterThanOrEqual(16)
          expectNoHorizontalOverflow(menu)
          expectNoHorizontalOverflow(document.body)
        })
      }
    }
  }
})
