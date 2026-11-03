import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { page, userEvent } from '@vitest/browser/context'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useMediaCatalog } from '@/stores/media-catalog-store'
import {
  DEFAULT_FONT_SIZE,
  expectNoHorizontalOverflow,
  expectOneLine,
  expectSameHeight,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
  XL_FONT_SIZE,
} from '@/test/layout'

import { CloudPage } from '../index'

/**
 * The page keeps its selection in the URL. A pick writes it where
 * `useSearch` reads it and re-renders, as the router does.
 */
const { search } = vi.hoisted(() => {
  type Search = { provider?: string }
  let current: Search = {}
  const listeners = new Set<() => void>()
  return {
    search: {
      get: () => current,
      set: (next: Search) => {
        current = next
        for (const listener of listeners) listener()
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  }
})

vi.mock('@tanstack/react-router', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    createFileRoute: () => (config: unknown) => config,
    redirect: (options: unknown) => options,
    useNavigate:
      () =>
      ({ search: next }: { search?: { provider?: string } }) =>
        search.set(next ?? {}),
    useRouter: () => ({ navigate: vi.fn() }),
    useSearch: () => useSyncExternalStore(search.subscribe, search.get),
  }
})

const serviceHubStub = {
  providers: () => ({
    updateSettings: vi.fn().mockResolvedValue(undefined),
    // The add-model dialog suggests the provider's own list.
    fetchModelsFromProvider: vi.fn().mockResolvedValue([]),
  }),
  auth: () => ({
    chatgptStatus: vi.fn().mockResolvedValue({ connected: false }),
    chatgptCancelLogin: vi.fn().mockResolvedValue(undefined),
    chatgptModels: vi.fn().mockResolvedValue([]),
  }),
}
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => serviceHubStub,
  getServiceHub: () => serviceHubStub,
}))

// The real store fetches the registry on import; the catalogue is not what
// is measured here.
vi.mock('@/stores/provider-registry-store', () => {
  const state = {
    status: 'idle',
    fetchedAt: null,
    hasInitialized: false,
    error: null,
    refresh: () => {},
  }
  return {
    useProviderRegistryStore: Object.assign(
      (selector?: (s: unknown) => unknown) =>
        selector ? selector(state) : state,
      { getState: () => state }
    ),
    isKnownProvider: () => true,
  }
})

const setting = (key: string, value: string): ProviderSetting => ({
  key,
  title: key,
  description:
    key === 'api-key'
      ? 'Visit your [API keys](https://example.test) page to create one.'
      : '',
  controller_type: 'input',
  controller_props: { value, placeholder: '' },
})

/** A worst-case model id: an aggregator's vendor path with a long name. */
const LONG_MODEL =
  'meta-llama/llama-4-maverick-17b-128e-instruct-fp8-extended-context-preview'

const hosted = (
  provider: string,
  models: string[],
  api_key = ''
): ProviderObject => ({
  provider,
  active: true,
  models: models.map(
    (id) => ({ id, capabilities: ['completion', 'tools'] }) as Model
  ),
  settings: [
    setting('api-key', api_key),
    setting('base-url', `https://${provider}.example.test/v1`),
  ],
  api_key,
  base_url: `https://${provider}.example.test/v1`,
})

const providers: ProviderObject[] = [
  hosted(
    'openai',
    ['gpt-5.4', 'gpt-5.4-mini', LONG_MODEL.split('/')[1]],
    'sk-live'
  ),
  hosted('anthropic', ['claude-sonnet-5', 'claude-opus-5']),
  hosted('gemini', ['gemini-3-pro']),
  hosted('openrouter', [
    'openai/gpt-5.4',
    LONG_MODEL,
    'anthropic/claude-sonnet-5',
  ]),
  hosted('deepseek', ['deepseek-v4']),
  hosted('groq', [LONG_MODEL]),
  hosted('mistral', ['mistral-large-3']),
  hosted('xai', ['grok-5']),
  { provider: 'chatgpt', active: true, models: [], settings: [] },
]

type PageLayout = 'list-detail' | 'side-by-side'

/**
 * The page beside the open sidebar is 708 px at a 1024 px window and 964 px
 * at 1280. Two panes need about 58em of the page's own text (812 px at
 * Medium, 1015 px at Extra Large), so only 1280 at Medium keeps both.
 */
const CASES: {
  width: number
  fontSize: string
  theme: 'light' | 'dark'
  layout: PageLayout
}[] = [
  // 58em of 13px Medium text fits beside the list at 1024 px.
  {
    width: 1024,
    fontSize: DEFAULT_FONT_SIZE,
    theme: 'light',
    layout: 'side-by-side',
  },
  { width: 1024, fontSize: XL_FONT_SIZE, theme: 'dark', layout: 'list-detail' },
  {
    width: 1280,
    fontSize: DEFAULT_FONT_SIZE,
    theme: 'light',
    layout: 'side-by-side',
  },
  { width: 1280, fontSize: XL_FONT_SIZE, theme: 'dark', layout: 'list-detail' },
]
const LIST_DETAIL = CASES.filter((c) => c.layout === 'list-detail')
const SIDE_BY_SIDE = CASES.filter((c) => c.layout === 'side-by-side')

/** `display: none` on an element or an ancestor leaves it without boxes. */
const isShown = (el: Element) => el.getClientRects().length > 0

/** The whole text of `el` is on screen: no ellipsis, no clamped line. */
function expectFullyShown(el: HTMLElement) {
  const clipped =
    el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1
  if (clipped) {
    expect.fail(
      `"${el.textContent}" is cut off: its text needs ` +
        `${el.scrollWidth}×${el.scrollHeight} px of a ${el.clientWidth}×${el.clientHeight} px box.`
    )
  }
}

/** `el` spans `root` from edge to edge. */
function expectFullWidth(el: Element, root: Element) {
  const box = el.getBoundingClientRect()
  const bounds = root.getBoundingClientRect()
  if (
    Math.abs(box.left - bounds.left) > 1 ||
    Math.abs(box.right - bounds.right) > 1
  ) {
    expect.fail(
      `${el.getAttribute('aria-label')} spans ${box.left}–${box.right} px of ` +
        `the page's ${bounds.left}–${bounds.right} px.`
    )
  }
}

// By label: Testing Library stops reporting a hidden `<aside>` as a landmark.
const catalog = () =>
  document.querySelector('aside[aria-label="Cloud catalog"]') as HTMLElement
const configuration = () =>
  document.querySelector(
    'section[aria-label="Provider configuration"]'
  ) as HTMLElement
const providerNames = () =>
  [...catalog().querySelectorAll('button[aria-pressed]')].map(
    (row) => row.querySelector('span > span') as HTMLElement
  )

/** The page in the app's column: beside the 60 px rail and 256 px sidebar. */
async function renderPage() {
  const view = render(
    withTranslations(
      <div className="flex h-[800px] w-full overflow-hidden">
        <aside className="w-[316px] shrink-0">Sidebar</aside>
        <main data-testid="page" className="min-w-0 flex-1">
          <CloudPage />
        </main>
      </div>
    )
  )
  await act(async () => {
    await settle(view.container)
  })
  return screen.getByTestId('page')
}

describe('Cloud providers page geometry', () => {
  beforeEach(() => {
    search.set({ provider: 'openai' })
    useModelProvider.setState({ providers })
    useMediaCatalog.setState({ available: false, status: 'ready' })
  })

  it.each(LIST_DETAIL)(
    'lists the providers, then configures one full-width at $width px / $fontSize / $theme',
    async ({ width, fontSize, theme }) => {
      await page.viewport(width, 800)
      setTheme(theme)
      setFontSize(fontSize)
      useGeneralSetting.setState({ cloudGuideDone: true })
      // Arriving from the sidebar: the URL names no provider.
      search.set({})
      const root = await renderPage()

      // The list fills the page, every provider named in full.
      expect(isShown(catalog())).toBe(true)
      expect(isShown(configuration())).toBe(false)
      expectFullWidth(catalog(), root)
      expectNoHorizontalOverflow(root)
      for (const name of providerNames()) expectFullyShown(name)

      // Choosing one from the keyboard opens its configuration in place of
      // the list, focus on the way back.
      const row = within(catalog()).getByRole('button', {
        name: 'Configure OpenRouter',
      })
      row.focus()
      await userEvent.keyboard('{Enter}')
      await act(async () => {
        await settle(root)
      })
      expect(isShown(catalog())).toBe(false)
      expect(isShown(configuration())).toBe(true)
      expectFullWidth(configuration(), root)
      const back = screen.getByRole('button', { name: 'All providers' })
      expect(document.activeElement).toBe(back)
      expect(
        within(configuration()).getByRole('heading', { name: 'OpenRouter' })
      ).toBeInTheDocument()
      // The key field keeps most of the page, and the model list follows.
      const key = configuration().querySelector(
        'input[type="password"]'
      ) as HTMLElement
      expect(key.getBoundingClientRect().width).toBeGreaterThan(
        root.getBoundingClientRect().width * 0.6
      )
      expect(
        isShown(within(configuration()).getByPlaceholderText('Search models'))
      ).toBe(true)
      expectNoHorizontalOverflow(root)

      // Back returns to the list, on the provider just configured.
      await userEvent.keyboard('{Enter}')
      await act(async () => {
        await settle(root)
      })
      expect(isShown(catalog())).toBe(true)
      expect(isShown(configuration())).toBe(false)
      expect(document.activeElement).toBe(row)
      expect(row).toHaveAttribute('aria-pressed', 'true')

      // A search that lists long ids across providers still fits.
      fireEvent.change(
        screen.getByRole('textbox', {
          name: 'Search cloud models or providers',
        }),
        { target: { value: 'llama' } }
      )
      await act(async () => {
        await settle(root)
      })
      // OpenAI, OpenRouter and Groq name it differently.
      expect(
        screen.getByText('Available through 3 providers')
      ).toBeInTheDocument()
      expectNoHorizontalOverflow(root)
      for (const heading of catalog().querySelectorAll('h3')) {
        expectOneLine(heading as HTMLElement)
      }
    }
  )

  it.each(SIDE_BY_SIDE)(
    'keeps the list beside the configuration at $width px / $fontSize / $theme',
    async ({ width, fontSize, theme }) => {
      await page.viewport(width, 800)
      setTheme(theme)
      setFontSize(fontSize)
      useGeneralSetting.setState({ cloudGuideDone: true })
      const root = await renderPage()

      expect(isShown(catalog())).toBe(true)
      expect(isShown(configuration())).toBe(true)
      expect(catalog().getBoundingClientRect().right).toBeLessThanOrEqual(
        configuration().getBoundingClientRect().left + 1
      )
      expect(
        screen.queryByRole('button', { name: 'All providers' })
      ).not.toBeInTheDocument()
      expectNoHorizontalOverflow(root)
      // A long name takes a second line rather than an ellipsis.
      for (const name of providerNames()) expectFullyShown(name)

      // Picking another provider leaves focus in the list.
      const row = within(catalog()).getByRole('button', {
        name: 'Configure OpenRouter',
      })
      row.focus()
      await userEvent.keyboard('{Enter}')
      await act(async () => {
        await settle(root)
      })
      expect(isShown(catalog())).toBe(true)
      expect(
        within(configuration()).getByRole('heading', { name: 'OpenRouter' })
      ).toBeInTheDocument()
      expect(document.activeElement).toBe(row)

      fireEvent.change(
        screen.getByRole('textbox', {
          name: 'Search cloud models or providers',
        }),
        { target: { value: 'llama' } }
      )
      await act(async () => {
        await settle(root)
      })
      expect(
        screen.getByText('Available through 3 providers')
      ).toBeInTheDocument()
      expectNoHorizontalOverflow(root)
      for (const heading of catalog().querySelectorAll('h3')) {
        expectOneLine(heading as HTMLElement)
      }
    }
  )

  it.each(CASES)(
    'lays the guide out in even cards at $width px / $fontSize / $theme',
    async ({ width, fontSize, theme }) => {
      await page.viewport(width, 800)
      setTheme(theme)
      setFontSize(fontSize)
      // Nothing connected and the guide never finished: it opens.
      useModelProvider.setState({
        providers: providers.map((p) => ({ ...p, api_key: '' })),
      })
      useGeneralSetting.setState({ cloudGuideDone: false })
      const root = await renderPage()

      const guide = screen.getByRole('region', {
        name: 'Cloud provider setup',
      })
      expectNoHorizontalOverflow(root)
      const choices = [
        ...guide.querySelectorAll('button[aria-label^="Choose"]'),
      ]
      expect(choices.length).toBe(9)
      expectSameHeight(choices)
    }
  )
})
