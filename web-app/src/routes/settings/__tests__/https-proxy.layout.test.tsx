import { render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { afterEach, describe, expect, it, vi } from 'vitest'

import i18n from '@/i18n/setup'
import {
  DEFAULT_FONT_SIZE,
  XL_FONT_SIZE,
  expectFits,
  expectNoHorizontalOverflow,
  setFontSize,
  settle,
  withTranslations,
} from '@/test/layout'

// Geometry only: no proxy is ever tested here.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tanstack/react-router', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createFileRoute: () => (config: any) => ({ ...config }),
}))

import { ServerPage } from '@/containers/server/ServerPageParts'

import { Route } from '../https-proxy'

const HttpsProxyPage = Route.component as React.ComponentType

/** Any other Server page, as far as its title block goes. */
const OtherServerPage = () => (
  <ServerPage title="Server configuration">
    <section className="sp-panel" />
  </ServerPage>
)

// The page column beside the 60 px rail and the 256 px sidebar.
async function renderPage(
  Page: React.ComponentType,
  width: number,
  language: string
) {
  await page.viewport(width, 800)
  i18n.changeLanguage(language)
  const { container, unmount } = render(
    <div className="flex w-full">
      <aside className="w-[316px] shrink-0">Sidebar</aside>
      <main data-testid="column" className="min-w-0 flex-1">
        {withTranslations(<Page />)}
      </main>
    </div>
  )
  await settle(container)
  return { column: screen.getByTestId('column'), unmount }
}

const top = (element: Element) => element.getBoundingClientRect().top

describe.each(['en', 'ru'])('Server → HTTPS Proxy in %s', (language) => {
  afterEach(() => setFontSize(DEFAULT_FONT_SIZE))

  it.each(
    [1024, 1280].flatMap((width) =>
      [DEFAULT_FONT_SIZE, XL_FONT_SIZE].map((fontSize) => ({ width, fontSize }))
    )
  )(
    'keeps the form inside its column at $width px / $fontSize',
    async ({ width, fontSize }) => {
      setFontSize(fontSize)
      const { column } = await renderPage(HttpsProxyPage, width, language)

      expectNoHorizontalOverflow(column)
      const url = screen.getByLabelText(i18n.t('settings:httpsProxy.proxyUrl'))
      const test = screen.getByRole('button', {
        name: i18n.t('settings:httpsProxy.test'),
      })
      // "Test connection" stays beside the address, one line high.
      expect(top(test)).toBeCloseTo(top(url), 0)
      expect(test.getBoundingClientRect().height).toBeCloseTo(
        url.getBoundingClientRect().height,
        0
      )
      expectFits(test, column)
      expect(
        top(screen.getByLabelText(i18n.t('settings:httpsProxy.password')))
      ).toBeCloseTo(
        top(screen.getByLabelText(i18n.t('settings:httpsProxy.username'))),
        0
      )
    }
  )
})

// The other Server pages name themselves in the section's title block; this
// one sat under the old settings header, which read "Settings" in a smaller type.
it('titles the page as the other Server pages are titled', async () => {
  const configuration = await renderPage(OtherServerPage, 1024, 'en')
  const reference = configuration.column.querySelector('h1')!
  const expected = {
    fontSize: getComputedStyle(reference).fontSize,
    left: reference.getBoundingClientRect().left,
    top: reference.getBoundingClientRect().top,
  }
  configuration.unmount()

  await renderPage(HttpsProxyPage, 1024, 'en')
  const title = screen.getByRole('heading', { level: 1 })

  expect(title).toHaveTextContent('HTTPS Proxy')
  expect(getComputedStyle(title).fontSize).toBe(expected.fontSize)
  expect(title.getBoundingClientRect().left).toBeCloseTo(expected.left, 0)
  expect(title.getBoundingClientRect().top).toBeCloseTo(expected.top, 0)
})
