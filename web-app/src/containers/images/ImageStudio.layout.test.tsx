import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_IMAGE_FORM, useImageForm } from '@/hooks/useImageForm'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useImageSetting } from '@/hooks/useImageSetting'
import {
  makeCapabilities,
  makeCatalog,
  makeFakeDiffusion,
  makeFilesFor,
  makeJob,
  makeLoadedStatus,
  makeStatus,
  MODELS_ROOT,
  Q4_ID,
  Q8_ID,
  Z_IMAGE,
} from '@/lib/diffusion/__tests__/image-fixtures'
import {
  diffusionDownloadTaskId,
  listInstalledArtifacts,
} from '@/lib/diffusion/models'
import {
  DEFAULT_FONT_SIZE,
  expectNoHorizontalOverflow,
  expectOneLine,
  settle,
  setFontSize,
  setTheme,
  withTranslations,
  XL_FONT_SIZE,
} from '@/test/layout'
import { seedServiceHub } from '@/test/service-hub'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { ImageModelSelector } from './ImageModelSelector'
import { ImageModelPicker } from './ImageModelPicker'
import { ImagePromptForm } from './ImagePromptForm'

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({
    to,
    children,
    ...props
  }: { to: string; children: React.ReactNode } &
    React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}))
vi.mock('@/containers/chatInput/useTauriDragDrop', () => ({
  useTauriDragDrop: () => undefined,
}))
vi.mock('@/lib/notifications', () => ({ notifyThreadCompleted: vi.fn() }))
vi.mock('@/lib/telemetry-queue', () => ({ queuedCapture: vi.fn() }))
vi.mock('@/hooks/useHardwareTier', () => ({
  useHardwareTier: () => ({
    tier: 'vram_8',
    ready: true,
    profile: {
      tier: 'vram_8',
      memoryKind: 'vram',
      budgetMib: 16 * 1024,
      systemRamMib: 32 * 1024,
      vramMib: 16 * 1024,
      hardCeiling: false,
    },
  }),
}))

const frame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

const q4Files = makeFilesFor(Z_IMAGE, 'q4_k_m')
const ONE_QUANT_FAMILY = {
  ...Z_IMAGE,
  id: 'flux.2-klein' as const,
  name: 'FLUX.2 Klein 4B',
  description:
    'A long one-quant model description that must truncate before the action.',
  transformer: {
    ...Z_IMAGE.transformer,
    quants: [Z_IMAGE.transformer.quants[0]],
  },
}
const ONE_QUANT_ID = 'flux.2-klein:q4_k_m'

async function seedImageStudio() {
  localStorage.clear()
  await useImageForm.persist.rehydrate()
  await useImageSetting.persist.rehydrate()
  useImageForm.setState({
    ...DEFAULT_IMAGE_FORM,
    prompt: 'A lighthouse at dusk',
  })
  useImageSetting.setState({
    selectedArtifactId: Q4_ID,
    advancedOpen: false,
  })
  useImageGenerationStore.getState().reset()
  useImageGenerationStore.setState({
    catalog: makeCatalog(),
    modelFiles: q4Files,
    installedArtifacts: listInstalledArtifacts(makeCatalog(), q4Files),
    status: makeLoadedStatus(Q4_ID),
    capabilities: makeCapabilities(),
    paths: {
      dataFolder: '/data',
      modelsRoot: MODELS_ROOT,
      backendsRoot: '/data/diffusion/backends',
      imagesDir: '/data/images',
      videosDir: '/data/videos',
    },
  })
  seedServiceHub({ diffusion: makeFakeDiffusion() })
}

describe('Image studio form geometry', () => {
  beforeEach(async () => {
    await page.viewport(1024, 1000)
    setTheme('light')
    await seedImageStudio()
  })

  it('keeps Generate and Stop in the exact same compact slot', async () => {
    render(
      withTranslations(
        <div className="flex h-[760px] w-[400px] overflow-hidden">
          <ImagePromptForm />
        </div>
      )
    )
    await act(async () => {
      await settle()
    })

    const slot = screen.getByTestId('image-generate-slot')
    const card = screen.getByTestId('image-prompt-card')
    expect(screen.queryByTestId('image-stop')).toBeNull()
    expect(screen.getByTestId('image-models-toggle')).toHaveClass('flex-1')
    const before = slot.getBoundingClientRect()
    const cardHeight = card.getBoundingClientRect().height
    expect(before.height).toBe(36)
    const cardStyle = getComputedStyle(card)
    expect(card.getBoundingClientRect().bottom - before.bottom).toBeCloseTo(
      parseFloat(cardStyle.paddingBottom) +
        parseFloat(cardStyle.borderBottomWidth),
      1
    )

    act(() => {
      useImageGenerationStore.setState({
        generating: true,
        currentJob: makeJob({ state: 'generating' }),
        runsTotal: 1,
        runsDone: 0,
      })
    })
    await act(async () => {
      await frame()
      await frame()
    })

    const after = screen
      .getByTestId('image-generate-slot')
      .getBoundingClientRect()
    expect(screen.getByTestId('image-stop')).toBeVisible()
    expect(screen.getByTestId('image-stop')).toBeVisible()
    expect(after.left).toBeCloseTo(before.left, 1)
    expect(after.top).toBeCloseTo(before.top, 1)
    expect(after.width).toBeCloseTo(before.width, 1)
    expect(after.height).toBeCloseTo(before.height, 1)
    expect(card.getBoundingClientRect().height).toBeCloseTo(cardHeight, 1)
    expect(screen.queryByTestId('image-job-progress')).toBeNull()
    expect(screen.queryByTestId('image-progress-slot')).toBeNull()
  })

  it('reserves the gutter across workflow growth and animates Advanced without a horizontal jump', async () => {
    render(
      withTranslations(
        <div
          className="flex w-[400px] overflow-hidden"
          data-testid="form-frame"
        >
          <ImagePromptForm />
        </div>
      )
    )
    await act(async () => {
      await settle()
    })

    const frameElement = screen.getByTestId('form-frame')
    const scroller = screen.getByTestId('image-form-scroller')
    frameElement.style.height = `${scroller.scrollHeight}px`
    await act(async () => {
      await frame()
      await frame()
    })

    const card = screen.getByTestId('image-prompt-card')
    const initial = card.getBoundingClientRect()
    expect(getComputedStyle(scroller).scrollbarGutter).toContain('stable')
    expect(scroller.scrollHeight).toBeLessThanOrEqual(scroller.clientHeight + 1)

    act(() => {
      useImageForm.setState({ workflow: 'transform' })
    })
    await act(async () => {
      await frame()
      await frame()
    })
    const transformed = card.getBoundingClientRect()
    expect(transformed.left).toBeCloseTo(initial.left, 1)
    expect(transformed.width).toBeCloseTo(initial.width, 1)

    act(() => {
      useImageForm.setState({ workflow: 'create' })
    })
    await act(async () => {
      await frame()
      await frame()
    })

    fireEvent.click(screen.getByTestId('image-advanced-toggle'))
    const panel = await screen.findByTestId('image-advanced-panel')
    const heights: number[] = []
    const rightEdges: number[] = []
    await act(async () => {
      for (let index = 0; index < 20; index += 1) {
        heights.push(panel.getBoundingClientRect().height)
        rightEdges.push(card.getBoundingClientRect().right)
        await frame()
      }
    })
    await act(async () => {
      await settle(panel)
    })
    const finalHeight = panel.getBoundingClientRect().height

    expect(finalHeight).toBeGreaterThan(100)
    expect(heights.some((height) => height > 0 && height < finalHeight)).toBe(
      true
    )
    expect(
      Math.max(...rightEdges) - Math.min(...rightEdges)
    ).toBeLessThanOrEqual(1)
    expect(card.getBoundingClientRect().width).toBeCloseTo(initial.width, 1)
    expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight)
    expect(panel).toHaveClass(
      'duration-250',
      'ease-out',
      'motion-reduce:animate-none'
    )
    expect(scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth)
  })

  it.each([
    {
      workflow: 'create' as const,
      width: 1024,
      fontSize: DEFAULT_FONT_SIZE,
      theme: 'light' as const,
    },
    {
      workflow: 'create' as const,
      width: 1024,
      fontSize: XL_FONT_SIZE,
      theme: 'dark' as const,
    },
    {
      workflow: 'create' as const,
      width: 1280,
      fontSize: DEFAULT_FONT_SIZE,
      theme: 'dark' as const,
    },
    {
      workflow: 'create' as const,
      width: 1280,
      fontSize: XL_FONT_SIZE,
      theme: 'light' as const,
    },
    {
      workflow: 'transform' as const,
      width: 1024,
      fontSize: DEFAULT_FONT_SIZE,
      theme: 'dark' as const,
    },
    {
      workflow: 'transform' as const,
      width: 1024,
      fontSize: XL_FONT_SIZE,
      theme: 'light' as const,
    },
    {
      workflow: 'transform' as const,
      width: 1280,
      fontSize: DEFAULT_FONT_SIZE,
      theme: 'light' as const,
    },
    {
      workflow: 'transform' as const,
      width: 1280,
      fontSize: XL_FONT_SIZE,
      theme: 'dark' as const,
    },
  ])(
    'keeps the embedded API card readable for $workflow at $width/$fontSize/$theme',
    async ({ workflow, width, fontSize, theme }) => {
      await page.viewport(width, 1000)
      setFontSize(fontSize)
      setTheme(theme)
      act(() => {
        useImageForm.setState({ workflow })
        useImageSetting.setState({ advancedOpen: true })
      })

      render(
        withTranslations(
          <div className="flex h-[900px] w-[400px] overflow-hidden">
            <ImagePromptForm />
          </div>
        )
      )
      await act(async () => {
        await settle()
      })

      const card = screen.getByTestId('image-api-settings-card')
      const scroller = screen.getByTestId('image-form-scroller')
      expect(card).toHaveAttribute('data-variant', 'embedded')
      expect(screen.getByTestId('image-api-endpoint')).toBeVisible()
      expect(screen.queryByTestId('image-api-curl')).toBeNull()
      expect(screen.queryByText('Requirements')).toBeNull()
      expect(screen.queryByText('Authentication')).toBeNull()
      expect(screen.queryByText('Request and response contract')).toBeNull()

      const actions = screen.getByTestId('image-api-embedded-actions')
      const copy = within(actions).getByRole('button', {
        name: 'Copy image API endpoint',
      })
      const more = within(actions).getByRole('link', { name: 'More' })
      const copyRect = copy.getBoundingClientRect()
      const moreRect = more.getBoundingClientRect()
      expect(copyRect.width).toBeCloseTo(moreRect.width, 1)
      expect(copyRect.height).toBeCloseTo(moreRect.height, 1)
      expect(Number.parseFloat(getComputedStyle(copy).borderRadius)).toBeGreaterThanOrEqual(
        copyRect.height / 2
      )
      expect(Number.parseFloat(getComputedStyle(more).borderRadius)).toBeGreaterThanOrEqual(
        moreRect.height / 2
      )
      expectOneLine(copy.querySelector('span')!)
      expectOneLine(more.querySelector('span')!)
      expectNoHorizontalOverflow(actions)

      const mediaSettings = screen.getByRole('button', {
        name: 'Open Media settings',
      })
      expect(
        Number.parseFloat(getComputedStyle(mediaSettings).borderRadius)
      ).toBeGreaterThanOrEqual(mediaSettings.getBoundingClientRect().height / 2)
      expectNoHorizontalOverflow(card)
      expect(scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth)
    }
  )
})

describe('Image model page-row geometry', () => {
  beforeEach(async () => {
    await page.viewport(1024, 800)
    setTheme('light')
    await seedImageStudio()
  })

  it('separates model metadata from controls and keeps primary actions compact', async () => {
    const availableFamily = {
      ...Z_IMAGE,
      id: 'flux.2-klein' as const,
      name: 'FLUX.2 Klein 4B',
      description:
        'A deliberately long one-line subtitle that must truncate cleanly.',
    }
    const catalog = makeCatalog([Z_IMAGE, availableFamily])
    act(() => {
      useImageGenerationStore.setState({
        catalog,
        installedArtifacts: listInstalledArtifacts(catalog, q4Files),
        status: makeStatus(),
      })
    })

    const view = render(
      withTranslations(
        <div className="w-[380px]">
          <ImageModelSelector variant="page" />
        </div>
      )
    )
    await act(async () => {
      await settle()
    })

    const installed = screen.getByTestId('family-z-image')
    const available = screen.getByTestId('family-flux.2-klein')
    const run = within(installed).getByRole('button', { name: 'Run' })
    const remove = within(installed).getByRole('button', { name: 'Remove' })

    expect(within(installed).queryByText('Good fit')).toBeNull()
    expect(within(installed).queryByText(/GB/)).toBeNull()
    expect(within(available).queryByText('Good fit')).toBeNull()
    expect(within(available).queryByText(/GB/)).toBeNull()
    expect(
      within(available).getByRole('button', { name: 'Download' })
    ).toBeVisible()
    for (const subtitle of screen.getAllByTestId('image-model-subtitle')) {
      expectOneLine(subtitle)
    }
    const installedSubtitle = within(installed).getByTestId(
      'image-model-subtitle'
    )
    const installedControls = within(installed).getByTestId(`artifact-${Q4_ID}`)
    expect(
      installedControls.getBoundingClientRect().top -
        installedSubtitle.getBoundingClientRect().bottom
    ).toBeGreaterThanOrEqual(10)
    expect(run.getBoundingClientRect().height).toBe(28)
    expect(remove.getBoundingClientRect().width).toBe(24)
    expect(remove.getBoundingClientRect().height).toBe(24)
    expect(run.querySelector('svg')).toBeNull()

    const quantTrigger = within(installed).getByRole('button', {
      name: /Select/,
    })
    const quantText = within(quantTrigger).getByText('Q4_K_M')
    expect(getComputedStyle(quantText).backgroundColor).toBe('rgba(0, 0, 0, 0)')

    const channels =
      getComputedStyle(run).backgroundColor.match(/\d+(?:\.\d+)?/g)
    expect(channels).not.toBeNull()
    expect(channels!.slice(0, 3).every((channel) => Number(channel) < 80)).toBe(
      true
    )

    fireEvent.pointerDown(
      within(available).getByRole('button', { name: /Select/ }),
      { button: 0, ctrlKey: false }
    )
    await act(async () => {
      await settle()
    })
    const availableQuant = screen.getByTestId('quant-flux.2-klein:q4_k_m')
    expect(within(availableQuant).getByText('Good fit')).toBeVisible()
    expect(within(availableQuant).getByText(/GB/)).toBeVisible()
    expect(availableQuant).toHaveAttribute('role', 'menuitem')
    expect(within(availableQuant).getByText('Download')).toBeVisible()
    expectNoHorizontalOverflow(view.container)
  })

  it.each([
    { fontSize: DEFAULT_FONT_SIZE, theme: 'light' as const },
    { fontSize: XL_FONT_SIZE, theme: 'dark' as const },
  ])(
    'keeps model runtime actions fixed through every phase at 1024/$fontSize/$theme',
    async ({ fontSize, theme }) => {
      await page.viewport(1024, 800)
      setFontSize(fontSize)
      setTheme(theme)
      act(() => {
        useImageGenerationStore.setState({
          status: makeStatus(),
          loadingArtifactId: null,
          unloadingArtifactId: null,
        })
      })

      const view = render(
        withTranslations(
          <div className="w-[380px] space-y-3 overflow-hidden">
            <ImageModelPicker open={false} onOpenChange={vi.fn()} />
            <ImageModelSelector variant="page" />
          </div>
        )
      )
      await act(async () => {
        await settle()
      })

      const rowAction = () => screen.getByTestId('image-model-runtime-action')
      const indicator = () =>
        screen.getByTestId('image-model-runtime-indicator')
      const toggle = screen.getByTestId('image-models-toggle')
      const initial = {
        row: rowAction().getBoundingClientRect(),
        indicator: indicator().getBoundingClientRect(),
        toggle: toggle.getBoundingClientRect(),
      }
      expect(rowAction()).toHaveAttribute('data-phase', 'idle')
      expect(indicator()).toHaveAttribute('data-phase', 'idle')

      const assertGeometry = () => {
        expect(rowAction().getBoundingClientRect().width).toBeCloseTo(
          initial.row.width,
          1
        )
        expect(rowAction().getBoundingClientRect().height).toBeCloseTo(
          initial.row.height,
          1
        )
        expect(indicator().getBoundingClientRect().width).toBeCloseTo(
          initial.indicator.width,
          1
        )
        expect(indicator().getBoundingClientRect().height).toBeCloseTo(
          initial.indicator.height,
          1
        )
        expect(toggle.getBoundingClientRect().width).toBeCloseTo(
          initial.toggle.width,
          1
        )
        expectNoHorizontalOverflow(view.container)
      }

      act(() => {
        useImageGenerationStore.setState({
          status: makeStatus({ model: { state: 'loading', loaded: null } }),
          loadingArtifactId: Q4_ID,
        })
      })
      await act(async () => {
        await frame()
        await frame()
      })
      expect(rowAction()).toHaveAttribute('data-phase', 'starting')
      expect(indicator()).toHaveAttribute('data-phase', 'starting')
      expect(rowAction()).not.toHaveTextContent('Starting')
      expect(toggle).not.toHaveTextContent('Starting')
      assertGeometry()

      act(() => {
        useImageGenerationStore.setState({
          status: makeLoadedStatus(Q4_ID),
          loadingArtifactId: null,
        })
      })
      await act(async () => {
        await frame()
        await frame()
      })
      expect(rowAction()).toHaveAttribute('data-phase', 'ready')
      expect(rowAction()).toHaveTextContent('Stop')
      expect(rowAction().querySelector('svg')).toBeNull()
      expect(indicator()).toHaveAttribute('data-phase', 'ready')
      assertGeometry()

      act(() => {
        useImageGenerationStore.setState({ unloadingArtifactId: Q4_ID })
      })
      await act(async () => {
        await frame()
        await frame()
      })
      expect(rowAction()).toHaveAttribute('data-phase', 'stopping')
      expect(indicator()).toHaveAttribute('data-phase', 'stopping')
      expect(rowAction()).not.toHaveTextContent('Stop')
      assertGeometry()

      act(() => {
        useImageGenerationStore.setState({
          status: makeStatus(),
          unloadingArtifactId: null,
        })
      })
      await act(async () => {
        await frame()
        await frame()
      })
      expect(rowAction()).toHaveAttribute('data-phase', 'idle')
      expect(indicator()).toHaveAttribute('data-phase', 'idle')
      assertGeometry()
    }
  )

  it.each([
    { width: 1024, fontSize: DEFAULT_FONT_SIZE, theme: 'light' as const },
    { width: 1024, fontSize: DEFAULT_FONT_SIZE, theme: 'dark' as const },
    { width: 1024, fontSize: XL_FONT_SIZE, theme: 'light' as const },
    { width: 1024, fontSize: XL_FONT_SIZE, theme: 'dark' as const },
    { width: 1280, fontSize: DEFAULT_FONT_SIZE, theme: 'light' as const },
    { width: 1280, fontSize: DEFAULT_FONT_SIZE, theme: 'dark' as const },
    { width: 1280, fontSize: XL_FONT_SIZE, theme: 'light' as const },
    { width: 1280, fontSize: XL_FONT_SIZE, theme: 'dark' as const },
  ])(
    'keeps the outer model row fixed while browsing an available quant at $width/$fontSize/$theme',
    async ({ width, fontSize, theme }) => {
      await page.viewport(width, 800)
      setFontSize(fontSize)
      setTheme(theme)

      const view = render(
        withTranslations(
          <div className="w-[380px]">
            <ImageModelSelector variant="page" />
          </div>
        )
      )
      await act(async () => {
        await settle()
      })

      const family = screen.getByTestId('family-z-image')
      const controls = within(family).getByTestId(`artifact-${Q4_ID}`)
      const beforeFamily = family.getBoundingClientRect()
      const beforeControls = controls.getBoundingClientRect()
      const beforeActionLabels = within(controls)
        .getAllByRole('button')
        .map(
          (button) => button.getAttribute('aria-label') || button.textContent
        )

      fireEvent.pointerDown(
        within(controls).getByRole('button', { name: /Select/ }),
        { button: 0, ctrlKey: false }
      )
      await act(async () => {
        await settle()
      })

      const menu = screen.getByTestId('quant-menu-z-image')
      const installed = screen.getByTestId(`quant-${Q4_ID}`)
      const available = screen.getByTestId(`quant-${Q8_ID}`)
      const download = screen.getByTestId(`quant-action-${Q8_ID}`)
      fireEvent.mouseEnter(available)
      download.focus()
      await act(async () => {
        await settle()
      })

      const afterFamily = family.getBoundingClientRect()
      const afterControls = controls.getBoundingClientRect()
      const afterActionLabels = within(controls)
        .getAllByRole('button', { hidden: true })
        .map(
          (button) => button.getAttribute('aria-label') || button.textContent
        )

      expect(screen.getByTestId('quant-group-downloaded')).toHaveTextContent(
        'Downloaded'
      )
      expect(screen.getByTestId('quant-group-available')).toBeVisible()
      expect(installed).toHaveAttribute('aria-current', 'true')
      expect(
        within(installed).queryByText('Downloaded', { selector: 'span' })
      ).toBeNull()
      expect(screen.getByTestId(`quant-downloaded-${Q4_ID}`)).toBeVisible()
      expect(within(available).getByText('Might fit')).toBeVisible()
      expect(within(available).getByText(/GB/)).toBeVisible()
      expect(download).toBeVisible()
      expect(available).toHaveAttribute('role', 'menuitem')
      expect(available).toHaveAccessibleName('Download Q8_0')
      expect(within(family).queryByText('Might fit')).toBeNull()
      expect(within(family).queryByText(/GB/)).toBeNull()
      expect(
        within(family).queryByRole('button', {
          name: 'Download',
          hidden: true,
        })
      ).toBeNull()
      expect(family).toHaveAttribute('data-artifact-id', Q4_ID)
      expect(afterActionLabels).toEqual(beforeActionLabels)
      expect(afterFamily.height).toBeCloseTo(beforeFamily.height, 1)
      expect(afterFamily.width).toBeCloseTo(beforeFamily.width, 1)
      expect(afterControls.top).toBeCloseTo(beforeControls.top, 1)
      expect(afterControls.height).toBeCloseTo(beforeControls.height, 1)
      expect(
        screen.getByTestId(`quant-action-${Q8_ID}`).getBoundingClientRect()
          .width
      ).toBe(96)
      expectNoHorizontalOverflow(menu)
      expectNoHorizontalOverflow(view.container)
    }
  )

  it.each([
    { width: 1024, fontSize: DEFAULT_FONT_SIZE, theme: 'light' as const },
    { width: 1024, fontSize: XL_FONT_SIZE, theme: 'dark' as const },
  ])(
    'keeps a one-quant outer Download slot fixed through progress at narrow width/$fontSize/$theme',
    async ({ width, fontSize, theme }) => {
      await page.viewport(width, 800)
      setFontSize(fontSize)
      setTheme(theme)
      const catalog = makeCatalog([ONE_QUANT_FAMILY])
      act(() => {
        useDownloadStore.setState({ downloads: {} })
        useImageGenerationStore.setState({
          catalog,
          modelFiles: [],
          installedArtifacts: [],
          status: makeStatus(),
        })
      })

      const view = render(
        withTranslations(
          <div className="w-[300px] overflow-hidden">
            <ImageModelSelector variant="page" />
          </div>
        )
      )
      await act(async () => {
        await settle()
      })

      const family = screen.getByTestId('family-flux.2-klein')
      const controls = within(family).getByTestId(
        `artifact-${ONE_QUANT_ID}`
      )
      const idle = within(controls).getByRole('button', { name: 'Download' })
      const before = idle.getBoundingClientRect()
      expect(before.width).toBe(96)
      expect(before.height).toBe(28)
      expectNoHorizontalOverflow(family)

      act(() => {
        useDownloadStore
          .getState()
          .updateProgress(
            diffusionDownloadTaskId(ONE_QUANT_ID),
            0.73,
            ONE_QUANT_ID,
            73,
            100
          )
      })
      await act(async () => {
        await settle()
      })

      const progress = within(controls).getByRole('button', {
        name: 'Cancel download',
      })
      const after = progress.getBoundingClientRect()
      expect(progress).toHaveTextContent('73%')
      expect(after.left).toBeCloseTo(before.left, 1)
      expect(after.top).toBeCloseTo(before.top, 1)
      expect(after.width).toBeCloseTo(before.width, 1)
      expect(after.height).toBeCloseTo(before.height, 1)
      expectNoHorizontalOverflow(family)
      expectNoHorizontalOverflow(view.container)
    }
  )
})
