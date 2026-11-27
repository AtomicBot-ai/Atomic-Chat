import { page } from '@vitest/browser/context'
import { render, screen, fireEvent } from '@testing-library/react'
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { useModelProvider } from '@/hooks/useModelProvider'
import { seedServiceHub } from '@/test/service-hub'
import { getCatalogSync } from '@/stores/model-catalog-store'
import { route } from '@/constants/routes'
import { switchToModel } from '@/utils/switchModel'
import { useState } from 'react'
import {
  withTranslations,
  setTheme,
  setFontSize,
  XL_FONT_SIZE,
  DEFAULT_FONT_SIZE,
  expectNoHorizontalOverflow,
  settle,
} from '@/test/layout'
import { DraftersHub } from './DraftersHub'
import { DrafterPicker } from '../DrafterPicker'
import { drafters } from '@/services/drafters'
import i18n from '@/i18n/setup'

vi.mock('@/stores/model-catalog-store', () => ({ getCatalogSync: vi.fn() }))
const navigate = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
vi.mock('@/utils/switchModel', () => ({ switchToModel: vi.fn() }))
vi.mock('@/services/drafters', () => ({
  drafters: {
    search: vi.fn(),
    list: vi.fn(),
    choices: vi.fn(),
    variants: vi.fn(),
    select: vi.fn(),
    selection: vi.fn(),
    remove: vi.fn(),
  },
  drafterError: String,
}))
const row = {
  target: 'Qwen/Qwen3-4B',
  file: 'community-checkpoint-'.repeat(12) + 'Q8_0.gguf',
  repo: 'author/DSpark',
  size: 570900704,
  quant: 'Q8_0',
  sha256: 'a'.repeat(64),
}
function Example({ width }: { width: number }) {
  const [q, setQ] = useState('Q8')
  const [source, setSource] = useState<string | undefined>(row.target)
  return (
    <div style={{ width }}>
      <DraftersHub
        tabs={null}
        q={q}
        source={source}
        onClear={() => setSource(undefined)}
        onQuery={setQ}
      />
      <div style={{ width: '20rem' }}>
        <DrafterPicker model="model-a" />
      </div>
    </div>
  )
}
describe('Desktop drafter discovery and selection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getCatalogSync).mockReturnValue([])
    seedServiceHub({})
    useModelProvider.setState({ providers: [], selectedModel: null })
  })
  it('offers discovery before a compatible file is installed', async () => {
    vi.mocked(drafters.choices).mockResolvedValue({
      files: [],
      id: null,
      target: row.target,
    })
    const view = render(withTranslations(<DrafterPicker model="local" />))
    await settle()
    expect(screen.getByRole('button', { name: 'Find drafters' })).toBeTruthy()
    const select = screen.getByRole('button', {
      name: /^Drafter /,
    }) as HTMLButtonElement
    expect(select.disabled).toBe(true)
    expect(select.textContent).toBe('Without a drafter')
    view.unmount()
  })

  it('finds drafters for a legacy installed GGUF from run settings before a head is installed', async () => {
    const repo = 'author/Qwen3.5-9B-GGUF'
    vi.mocked(getCatalogSync).mockReturnValue([
      {
        model_name: repo,
        developer: 'author',
        downloads: 0,
        description: '',
        quants: [
          {
            model_id: 'Qwen3.5-9B-Q4',
            path: 'weights.gguf',
            file_size: '1 GB',
          },
        ],
      },
    ])
    vi.mocked(drafters.choices).mockResolvedValue({ files: [], id: null })
    const view = render(
      withTranslations(<DrafterPicker model="author/Qwen3_5-9B-Q4" />)
    )
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Find drafters',
      })
    )
    expect(screen.getByRole('button', { name: /^Drafter / })).toBeDisabled()
    expect(navigate).toHaveBeenCalledWith({
      to: route.hub.index,
      search: { category: 'drafters', source: repo },
    })
    view.unmount()
  })

  it('opens a model-filtered search from run settings', async () => {
    vi.mocked(drafters.choices).mockResolvedValue({
      files: [row],
      id: null,
      target: row.target,
    })
    const view = render(withTranslations(<DrafterPicker model="local" />))
    fireEvent.click(
      await screen.findByRole('button', { name: 'Find drafters' })
    )
    expect(screen.getByRole('button', { name: /^Drafter / })).toBeEnabled()
    expect(navigate).toHaveBeenCalledWith({
      to: route.hub.index,
      search: { category: 'drafters', target: row.target },
    })
    view.unmount()
  })
  it.each([true, false])(
    'opens the downloaded head with its exact base when installed=%s',
    async (installed) => {
      const repo = 'org/Source-GGUF'
      const models = [{ id: 'other' }, { id: 'compatible' }]
      useModelProvider.setState({
        providers: [
          {
            provider: 'llamacpp-upstream',
            active: true,
            models,
          } as ModelProvider,
        ],
      })
      vi.mocked(drafters.list).mockResolvedValue({
        files: [row],
        downloads: [],
      })
      vi.mocked(drafters.search).mockResolvedValue({
        results: [row],
        target: row.target,
        partial: false,
      })
      vi.mocked(drafters.choices).mockImplementation(async (id) => ({
        id: null,
        files: [],
        target: installed && id === 'compatible' ? row.target : 'org/Other',
      }))
      vi.mocked(drafters.selection).mockResolvedValue(null)
      const view = render(
        withTranslations(
          <DraftersHub
            source={repo}
            tabs={null}
            q=""
            onClear={() => {}}
            onQuery={() => {}}
          />
        )
      )
      const primary = await screen.findByRole('button', {
        name: installed ? 'New chat' : 'View model',
      })
      const remove = screen.getByRole('button', { name: 'Remove' })
      expect(remove.getBoundingClientRect().right).toBeLessThan(
        primary.getBoundingClientRect().left
      )
      expect(remove.dataset.variant).toBe('destructive')
      fireEvent.click(primary)
      await vi.waitFor(() => expect(navigate).toHaveBeenCalled())
      if (installed) {
        expect(drafters.select).toHaveBeenCalledWith('compatible', row.sha256)
        expect(switchToModel).toHaveBeenCalledWith(
          expect.objectContaining({
            modelId: 'compatible',
            providerName: 'llamacpp-upstream',
          })
        )
        expect(navigate).toHaveBeenCalledWith({
          to: route.home,
          search: {
            threadModel: { id: 'compatible', provider: 'llamacpp-upstream' },
          },
        })
      } else {
        expect(navigate).toHaveBeenCalledWith({
          to: route.hub.index,
          search: { model: repo, repo, engine: 'gguf' },
        })
        expect(drafters.select).not.toHaveBeenCalled()
      }
      view.unmount()
    }
  )
  it('removes the downloaded file from discovery and offers Download again', async () => {
    vi.mocked(drafters.list).mockResolvedValue({ files: [row], downloads: [] })
    vi.mocked(drafters.search).mockResolvedValue({
      results: [row],
      partial: false,
    })
    vi.mocked(drafters.remove).mockImplementationOnce(async () => {
      vi.mocked(drafters.list).mockResolvedValue({ files: [], downloads: [] })
    })
    const view = render(
      withTranslations(
        <DraftersHub
          tabs={null}
          target={row.target}
          q=""
          onClear={() => {}}
          onQuery={() => {}}
        />
      )
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    expect(drafters.remove).toHaveBeenCalledWith(row.sha256)
    await screen.findByRole('button', { name: 'Download' })
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
    view.unmount()
  })

  it('restores the previous binding when a new chat cannot load its model', async () => {
    const model = { id: 'compatible' }
    useModelProvider.setState({
      providers: [
        { provider: 'llamacpp-upstream', models: [model] } as ModelProvider,
      ],
    })
    vi.mocked(drafters.list).mockResolvedValue({ files: [row], downloads: [] })
    vi.mocked(drafters.search).mockResolvedValue({
      results: [row],
      partial: false,
    })
    vi.mocked(drafters.selection).mockResolvedValue(null)
    vi.mocked(drafters.choices).mockResolvedValue({
      id: null,
      target: row.target,
      files: [row],
    })
    vi.mocked(switchToModel).mockRejectedValueOnce(
      new Error('Unable to start engine')
    )
    const view = render(
      withTranslations(
        <DraftersHub tabs={null} q="" onClear={() => {}} onQuery={() => {}} />
      )
    )
    fireEvent.click(await screen.findByRole('button', { name: 'New chat' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Unable to start engine'
    )
    expect(vi.mocked(drafters.select).mock.calls).toEqual([
      [model.id, row.sha256],
      [model.id, null],
    ])
    expect(navigate).not.toHaveBeenCalled()
    view.unmount()
  })

  it('shows returned variants as individual files without a quantization picker', async () => {
    vi.mocked(drafters.list).mockResolvedValue({ files: [], downloads: [] })
    vi.mocked(drafters.search).mockResolvedValue({
      results: [
        row,
        {
          ...row,
          sha256: 'b'.repeat(64),
          file: 'head-BF16.gguf',
          quant: 'BF16',
        },
      ],
      partial: false,
    })
    const view = render(
      withTranslations(
        <DraftersHub tabs={null} q="" onClear={() => {}} onQuery={() => {}} />
      )
    )
    await screen.findByTitle('head-BF16.gguf')
    expect(screen.getAllByRole('button', { name: 'Download' })).toHaveLength(2)
    expect(screen.queryByRole('combobox', { name: 'GGUF variant' })).toBeNull()
    view.unmount()
  })
  it('automatically exhausts sparse model search pages and shows every verified file with a Download button', async () => {
    await i18n.changeLanguage('en')
    const files = Array.from({ length: 6 }, (_, i) => ({
      ...row,
      file: 'head-' + i + '.gguf',
      sha256: String(i).repeat(64),
      moreVariants: true,
    }))
    vi.mocked(drafters.list).mockResolvedValue({ files: [], downloads: [] })
    vi.mocked(drafters.search).mockImplementation(
      async (_source, _target, _query, live, page = 0) => ({
        target: row.target,
        partial: live && page === 0,
        hasMore: live && page < 5,
        results: live ? files.slice(0, page + 1) : [],
      })
    )
    const view = render(
      withTranslations(
        <DraftersHub
          tabs={null}
          source={row.target}
          q=""
          onClear={() => {}}
          onQuery={() => {}}
        />
      )
    )
    await screen.findByTitle(files[5].file)
    expect(
      vi
        .mocked(drafters.search)
        .mock.calls.filter((args) => args[3])
        .map((args) => args[4])
    ).toEqual([0, 1, 2, 3, 4, 5])
    expect(screen.getAllByRole('button', { name: 'Download' })).toHaveLength(6)
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'GGUF variant' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    view.unmount()
  })
  it('keeps the catalog available offline and retries the live search', async () => {
    await i18n.changeLanguage('en')
    vi.mocked(drafters.list).mockResolvedValue({ files: [], downloads: [] })
    let offline = true
    vi.mocked(drafters.search).mockImplementation(
      async (source, _target, _q, live) => ({
        results: [row],
        partial: live && offline,
        target: source,
      })
    )
    const view = render(
      withTranslations(
        <DraftersHub
          tabs={null}
          source={row.target}
          q=""
          onQuery={() => {}}
          onClear={() => {}}
        />
      )
    )
    const retry = await screen.findByRole('button', { name: 'Retry' })
    expect(screen.getByTitle(row.file)).toBeTruthy()
    offline = false
    fireEvent.click(retry)
    await vi.waitFor(() =>
      expect(
        vi.mocked(drafters.search).mock.calls.filter((args) => args[3]).length
      ).toBeGreaterThan(1)
    )
    await vi.waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    )
    view.unmount()
  })
  it.each([
    [1024, XL_FONT_SIZE, 'dark'],
    [1280, DEFAULT_FONT_SIZE, 'light'],
  ] as const)(
    'fits the %ipx window and keeps the query when clearing its target',
    async (width, font, theme) => {
      await i18n.changeLanguage('en')
      await page.viewport(width, 800)
      setFontSize(font)
      setTheme(theme)
      vi.mocked(drafters.list).mockResolvedValue({
        files: [row],
        downloads: [],
      })
      vi.mocked(drafters.choices).mockResolvedValue({
        target: row.target,
        id: null,
        files: [row],
      })
      vi.mocked(drafters.search).mockImplementation(async (source) => ({
        results: [row],
        partial: false,
        target: source,
      }))
      vi.mocked(drafters.select).mockResolvedValue(undefined)
      const view = render(withTranslations(<Example width={width - 300} />))
      const link = await screen.findByRole('link', { name: 'Hugging Face' })
      expect(link.getAttribute('href')).toBe(
        `https://huggingface.co/${row.repo}`
      )
      expect(link.getAttribute('target')).toBe('_blank')
      await screen.findByTitle(row.file)
      fireEvent.click(
        screen.getByRole('button', { name: 'Remove model filter' })
      )
      expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Q8')
      await screen.findByTitle(row.file)
      const choice = screen.getByRole('button', { name: /^Drafter / })
      await settle()
      expectNoHorizontalOverflow(
        view.container.firstElementChild as HTMLElement
      )
      expect(choice.offsetWidth).toBeLessThanOrEqual(
        choice.parentElement!.clientWidth
      )
      fireEvent.keyDown(choice, { key: 'ArrowDown' })
      const menu = await screen.findByRole('menu')
      await settle()
      const anchor = choice.getBoundingClientRect()
      const box = menu.getBoundingClientRect()
      expect(box.top).toBeGreaterThanOrEqual(anchor.bottom)
      expect(box.width).toBeCloseTo(anchor.width, 0)
      expectNoHorizontalOverflow(menu)
      fireEvent.click(screen.getByRole('menuitemradio', { name: row.file }))
      await vi.waitFor(() => expect(choice.textContent).toContain('Q8_0'))
      fireEvent.keyDown(choice, { key: 'ArrowDown' })
      const selected = await screen.findByRole('menuitemradio', {
        name: row.file,
        checked: true,
      })
      expect(selected).toBeTruthy()
      fireEvent.click(
        screen.getByRole('menuitemradio', { name: 'Without a drafter' })
      )
      await vi.waitFor(() =>
        expect(choice.textContent).toBe('Without a drafter')
      )
      expect(vi.mocked(drafters.select).mock.calls).toEqual([
        ['model-a', row.sha256],
        ['model-a', null],
      ])
      view.unmount()
    }
  )
})
