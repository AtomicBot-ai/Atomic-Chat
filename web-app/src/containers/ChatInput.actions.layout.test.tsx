/**
 * The composer's action row as one system (design review D3) and at large
 * type (D4), measured in Chromium with the real tools menu, web-search globe,
 * microphone and model pill.
 *
 * D3: every icon action is drawn at the dense 28 px scale but takes clicks on
 * a 36 px box (Send: 40 px), neighbours sit 8 px apart, Tab walks the row in
 * the order it reads, and keyboard focus shows a ring that nothing clips.
 * D4: at Medium and Extra Large, at 1024 and 1280 px, with the sidebar open
 * and closed, Send and the model pill stay on screen and no control overlaps
 * another.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { page, userEvent } from '@vitest/browser/context'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import ChatInput from './ChatInput'
import { useAppState } from '@/hooks/useAppState'
import { useMCPServers } from '@/hooks/useMCPServers'
import { useModelProvider } from '@/hooks/useModelProvider'
import { usePrompt } from '@/hooks/usePrompt'
import { useThreads } from '@/hooks/useThreads'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import i18n from '@/i18n/setup'
import type { ModelsService } from '@/services/models/types'
import { seedServiceHub } from '@/test/service-hub'
import {
  DEFAULT_FONT_SIZE,
  expectNoHorizontalOverflow,
  setFontSize,
  settle,
  withTranslations,
  XL_FONT_SIZE,
} from '@/test/layout'

// The microphone is a platform feature; on here so the real toggle renders.
vi.mock('@/lib/platform/const', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/const')>()
  return {
    ...actual,
    PlatformFeatures: { ...actual.PlatformFeatures, voiceInput: true },
  }
})
vi.mock('motion/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('motion/react')>()),
  useReducedMotion: () => true,
}))
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useRouter: () => ({ navigate: vi.fn() }),
  useNavigate: () => vi.fn(),
}))
vi.mock('@/hooks/useTools', () => ({ useTools: vi.fn() }))
vi.mock('@/hooks/useAgentSkills', () => ({
  useAgentSkills: () => ({ skills: [], loading: false, setEnabled: vi.fn() }),
}))
vi.mock('@/hooks/useMCPServerStatuses', () => ({
  useMCPServerStatuses: () => ({ statusByName: new Map() }),
}))
vi.mock('@/containers/chatInput/useTauriDragDrop', () => ({
  useTauriDragDrop: vi.fn(),
}))
vi.mock('@/lib/extension', () => ({
  ExtensionManager: { getInstance: () => ({ get: () => undefined }) },
}))
vi.mock('@/stores/provider-registry-store', () => ({
  isKnownProvider: () => false,
  useProviderRegistryStore: {
    getState: () => ({ hasInitialized: true, providers: [] }),
  },
}))
vi.mock('./ModelPickerDownloads', () => ({
  HuggingFaceAction: () => null,
  ModelPickerEmptyState: () => null,
}))
vi.mock('./dialogs/AddCloudProviderDialog', () => ({
  AddCloudProviderDialog: () => null,
}))
vi.mock('@/containers/ReplyModelGate', () => ({ ReplyModelGate: () => null }))
vi.mock('@/components/TokenCounter', () => ({ TokenCounter: () => null }))

/** A connected cloud model that takes tools: the whole row is on show. */
const cloudModel = {
  id: 'gpt-4.1-mini',
  capabilities: ['completion', 'tools'],
  settings: {},
} as unknown as Model
const cloudProvider = {
  provider: 'openai',
  active: true,
  api_key: 'sk-test',
  models: [cloudModel],
  settings: [
    {
      key: 'api-key',
      title: 'API key',
      description: '',
      controller_type: 'input',
      controller_props: { value: 'sk-test' },
    },
  ],
} as unknown as ModelProvider

beforeEach(() => {
  seedServiceHub({
    models: {
      getActiveModels: vi.fn().mockResolvedValue([]),
    } as unknown as ModelsService,
  })
  useThreads.setState({ currentThreadId: undefined })
  usePrompt.setState({ prompt: '' })
  useAppState.setState({ tools: [] })
  useToolAvailable.setState({
    defaultMutedServers: [],
    defaultDisabledTools: [],
  })
  useMCPServers.setState({
    mcpServers: { exa: { command: '', args: [], env: {}, active: false } },
  })
  useModelProvider.setState({
    providers: [cloudProvider],
    selectedProvider: 'openai',
    selectedModel: cloudModel,
  })
})

afterEach(async () => {
  await page.viewport(1280, 800)
  await i18n.changeLanguage('en')
})

/** The chat column beside a 304 px sidebar (open) or on its own (closed). */
async function renderComposer(sidebarOpen: boolean) {
  render(
    withTranslations(
      <div className="app-shell flex h-screen w-screen">
        {sidebarOpen && <aside className="w-76 shrink-0" />}
        <main className="flex min-w-0 flex-1 flex-col justify-end px-4 pb-4">
          <ChatInput />
        </main>
      </div>
    )
  )
  await act(async () => {
    await settle()
  })
  await act(async () => {
    fireEvent.change(screen.getByTestId('chat-input'), {
      target: { value: 'Reply exactly RC234_CHOICE' },
    })
  })
  await act(async () => {
    await settle()
  })
}

const toolbar = () => screen.getByTestId('composer-toolbar')
const pillShell = () => screen.getByTestId('model-picker-pill-shell')
const sendButton = () =>
  screen.getByTestId('send-control').querySelector('button')!

/** The controls a user aims at, as boxes: the pill counts as one. */
function actions(): HTMLElement[] {
  const pill = pillShell()
  const buttons = [
    ...toolbar().querySelectorAll<HTMLElement>('button, [tabindex="0"]'),
  ].filter((el) => {
    if (pill.contains(el)) return false
    const box = el.getBoundingClientRect()
    return box.width > 0 && box.height > 0
  })
  return [...buttons, pill].sort(
    (a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left
  )
}

function name(el: Element): string {
  return (
    el.getAttribute('aria-label') ??
    el.getAttribute('data-testid') ??
    el.textContent?.trim() ??
    el.tagName
  )
}

function expectInViewport(el: Element) {
  const box = el.getBoundingClientRect()
  expect(box.left, `${name(el)} left`).toBeGreaterThanOrEqual(-0.5)
  expect(box.top, `${name(el)} top`).toBeGreaterThanOrEqual(-0.5)
  expect(box.right, `${name(el)} right`).toBeLessThanOrEqual(
    window.innerWidth + 0.5
  )
  expect(box.bottom, `${name(el)} bottom`).toBeLessThanOrEqual(
    window.innerHeight + 0.5
  )
}

/** No ancestor that clips cuts into `el` grown by `reach` px on every side. */
function expectUnclipped(el: HTMLElement, reach = 0) {
  const box = el.getBoundingClientRect()
  for (
    let parent = el.parentElement;
    parent && parent !== document.body;
    parent = parent.parentElement
  ) {
    const style = getComputedStyle(parent)
    const clipsX = style.overflowX !== 'visible'
    const clipsY = style.overflowY !== 'visible'
    if (!clipsX && !clipsY) continue
    const outer = parent.getBoundingClientRect()
    const left = outer.left + parent.clientLeft
    const top = outer.top + parent.clientTop
    const right = left + parent.clientWidth
    const bottom = top + parent.clientHeight
    const cut =
      (clipsX &&
        (box.left - reach < left - 0.5 || box.right + reach > right + 0.5)) ||
      (clipsY &&
        (box.top - reach < top - 0.5 || box.bottom + reach > bottom + 0.5))
    if (cut) {
      expect.fail(
        `${name(el)} (${reach} px around it) is clipped by <${parent.tagName.toLowerCase()} class="${parent.className}">`
      )
    }
  }
}

/** Top-level commas only: a colour like `oklab(… / 0.5)` holds its own. */
function shadows(value: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '(') depth++
    else if (value[i] === ')') depth--
    else if (value[i] === ',' && depth === 0) {
      out.push(value.slice(start, i).trim())
      start = i + 1
    }
  }
  out.push(value.slice(start).trim())
  return out
}

/** The focus ring `el` draws now: its width, and whether it is drawn inside. */
function focusRing(el: Element): { spread: number; inset: boolean } | null {
  const style = getComputedStyle(el)
  let ring: { spread: number; inset: boolean } | null = null
  if (style.boxShadow !== 'none') {
    for (const shadow of shadows(style.boxShadow)) {
      if (/rgba\(0, 0, 0, 0\)|\/ 0\)|transparent/.test(shadow)) continue
      const lengths = [...shadow.matchAll(/(-?[\d.]+)px/g)].map((m) =>
        parseFloat(m[1])
      )
      const spread = lengths[3] ?? 0
      if (spread < 1) continue
      if (!ring || spread > ring.spread) {
        ring = { spread, inset: /\binset\b/.test(shadow) }
      }
    }
  }
  if (!ring && style.outlineStyle !== 'none') {
    const width = parseFloat(style.outlineWidth) || 0
    if (width >= 1) {
      ring = {
        spread: width + Math.max(0, parseFloat(style.outlineOffset) || 0),
        inset: false,
      }
    }
  }
  return ring
}

const sizes = [1024, 1280].flatMap((width) =>
  [DEFAULT_FONT_SIZE, XL_FONT_SIZE].flatMap((fontSize) =>
    [true, false].map((sidebarOpen) => ({ width, fontSize, sidebarOpen }))
  )
)

describe('Composer actions (Chromium)', () => {
  it.each(sizes)(
    'D4: $width px / $fontSize / sidebar open $sidebarOpen: Send and the pill on screen, nothing overlaps',
    async ({ width, fontSize, sidebarOpen }) => {
      await page.viewport(width, 800)
      setFontSize(fontSize)
      await renderComposer(sidebarOpen)

      const send = sendButton()
      const pill = pillShell()
      expect(send).toHaveAccessibleName('Send Message')
      expectInViewport(send)
      expectInViewport(pill)

      const row = actions()
      // Paperclip, access menu, tools, web search, pill, microphone, Send.
      expect(row.map(name)).toEqual([
        'Attach files',
        'Restricted',
        'Plugins',
        expect.stringMatching(/web search/i),
        'model-picker-pill-shell',
        expect.stringMatching(/voice|dictat|microphone/i),
        'Send Message',
      ])
      for (const [i, el] of row.entries()) {
        expectInViewport(el)
        expectUnclipped(el)
        const next = row[i + 1]
        if (!next) continue
        // Strictly left to right, 8 px apart at least: no two overlap.
        const gap =
          next.getBoundingClientRect().left - el.getBoundingClientRect().right
        expect(gap, `${name(el)} → ${name(next)}`).toBeGreaterThanOrEqual(7.5)
      }
      expectNoHorizontalOverflow(
        document.querySelector<HTMLElement>('[data-composer-anchor]')!
      )
    }
  )

  // A long access label at the largest type and the narrowest column: the
  // pill folds before anything collides.
  it('D4: Russian labels at Extra Large in a 1024 px window with the sidebar open', async () => {
    await i18n.changeLanguage('ru')
    await page.viewport(1024, 800)
    setFontSize(XL_FONT_SIZE)
    await renderComposer(true)

    const row = actions()
    expect(row).toHaveLength(7)
    for (const [i, el] of row.entries()) {
      expectInViewport(el)
      expectUnclipped(el)
      const next = row[i + 1]
      if (next) {
        expect(
          next.getBoundingClientRect().left - el.getBoundingClientRect().right,
          `${name(el)} → ${name(next)}`
        ).toBeGreaterThanOrEqual(7.5)
      }
    }
    expectNoHorizontalOverflow(
      document.querySelector<HTMLElement>('[data-composer-anchor]')!
    )
  })

  it.each([DEFAULT_FONT_SIZE, XL_FONT_SIZE])(
    'D3: one 28 px icon action with a 36 px target, 8 px apart; Send 40 px / %s',
    async (fontSize) => {
      await page.viewport(1280, 800)
      setFontSize(fontSize)
      await renderComposer(false)

      const icons = [...toolbar().querySelectorAll<HTMLElement>('.hit-area-36')]
      // Paperclip, tools, web search, microphone.
      expect(icons).toHaveLength(4)
      for (const icon of icons) {
        const box = icon.getBoundingClientRect()
        expect(box.width, name(icon)).toBeCloseTo(28, 0)
        expect(box.height, name(icon)).toBeCloseTo(28, 0)
        expect(icon).toHaveAttribute('data-variant', 'ghost')
        const target = getComputedStyle(icon, '::after')
        expect(parseFloat(target.width), name(icon)).toBeCloseTo(36, 0)
        expect(parseFloat(target.height), name(icon)).toBeCloseTo(36, 0)
      }

      const send = sendButton()
      const s = send.getBoundingClientRect()
      expect(s.width).toBeCloseTo(28, 0)
      expect(parseFloat(getComputedStyle(send, '::after').width)).toBeCloseTo(
        40,
        0
      )
      expect(parseFloat(getComputedStyle(send, '::after').height)).toBeCloseTo(
        40,
        0
      )

      // 8 px between neighbours inside each cluster.
      const row = actions()
      const at = (label: string | RegExp) =>
        row.find((el) =>
          typeof label === 'string' ? name(el) === label : label.test(name(el))
        )!
      const gap = (a: Element, b: Element) =>
        b.getBoundingClientRect().left - a.getBoundingClientRect().right
      expect(gap(at('Attach files'), at('Restricted'))).toBeCloseTo(8, 0)
      expect(gap(at('Restricted'), at('Plugins'))).toBeCloseTo(8, 0)
      expect(gap(at('Plugins'), at(/web search/i))).toBeCloseTo(8, 0)
      expect(gap(pillShell(), at(/voice|dictat|microphone/i))).toBeCloseTo(8, 0)
      expect(gap(at(/voice|dictat|microphone/i), send)).toBeCloseTo(8, 0)
      // Every control in the row sits on one centre line.
      const centre = (el: Element) => {
        const box = el.getBoundingClientRect()
        return box.top + box.height / 2
      }
      for (const el of row) {
        expect(Math.abs(centre(el) - centre(send)), name(el)).toBeLessThan(1)
      }
      expectNoHorizontalOverflow(
        document.querySelector<HTMLElement>('[data-composer-anchor]')!
      )
    }
  )

  it.each([DEFAULT_FONT_SIZE, XL_FONT_SIZE])(
    'D3: Tab walks the row left to right and every stop shows an unclipped ring / %s',
    async (fontSize) => {
      await page.viewport(1280, 800)
      setFontSize(fontSize)
      await renderComposer(true)

      screen.getByTestId('chat-input').focus()
      const stops: HTMLElement[] = []
      for (let i = 0; i < 16; i++) {
        await userEvent.tab()
        const active = document.activeElement as HTMLElement | null
        if (!active || !toolbar().contains(active)) break
        // Buttons ease their ring in (`transition-all`); read it settled.
        await act(async () => {
          await settle(active)
        })
        stops.push(active)
        const ring = focusRing(active)
        expect(ring, `${name(active)} shows no focus ring`).not.toBeNull()
        expectUnclipped(active, ring!.inset ? 0 : ring!.spread)
      }

      // Paperclip, access menu, tools, globe, the pill's trigger, mic, Send
      // (the pill may add its status dot before the trigger).
      expect(stops.length).toBeGreaterThanOrEqual(7)
      expect(stops[0]).toHaveAccessibleName('Attach files')
      expect(stops.at(-1)).toBe(sendButton())
      const lefts = stops.map((el) => el.getBoundingClientRect().left)
      for (let i = 1; i < lefts.length; i++) {
        expect(
          lefts[i],
          `${name(stops[i])} after ${name(stops[i - 1])}`
        ).toBeGreaterThan(lefts[i - 1])
      }
    }
  )

  it('D3: the tools button opens its menu from the keyboard and takes focus back', async () => {
    await renderComposer(false)

    const tools = screen.getByRole('button', { name: 'Plugins' })
    tools.focus()
    await userEvent.keyboard('{Enter}')
    expect(await screen.findByRole('menu')).toBeVisible()
    expect(tools).toHaveAttribute('aria-expanded', 'true')

    await userEvent.keyboard('{Escape}')
    await act(async () => {
      await settle()
    })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(tools)
  })

  // AC-02: with nothing selected, a Send that will load a model says which,
  // and looks like the Send it is.
  it('AC-02: names the model a send will load, at the size and weight of Send', async () => {
    const local = {
      id: 'Qwen3.5-4B-Q4_K_M',
      capabilities: ['completion'],
      settings: {},
    } as unknown as Model
    useModelProvider.setState({
      providers: [
        {
          provider: 'llamacpp-upstream',
          active: true,
          models: [local],
          settings: [],
        } as unknown as ModelProvider,
      ],
      selectedProvider: '',
      selectedModel: null,
    })
    await renderComposer(false)

    const send = sendButton()
    expect(send).toHaveAccessibleName('Send with Qwen3.5 4B')
    expect(send).toHaveAttribute('data-variant', 'default')
    const box = send.getBoundingClientRect()
    expect(box.width).toBeCloseTo(28, 0)
    expect(box.height).toBeCloseTo(28, 0)
    expectInViewport(send)
  })
})
