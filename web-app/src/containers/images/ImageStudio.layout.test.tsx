import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_IMAGE_FORM, useImageForm } from '@/hooks/useImageForm'
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
  Z_IMAGE,
} from '@/lib/diffusion/__tests__/image-fixtures'
import { listInstalledArtifacts } from '@/lib/diffusion/models'
import {
  expectNoHorizontalOverflow,
  expectOneLine,
  settle,
  setTheme,
  withTranslations,
} from '@/test/layout'
import { seedServiceHub } from '@/test/service-hub'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { ImageModelSelector } from './ImageModelSelector'
import { ImagePromptForm } from './ImagePromptForm'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
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
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    expect(screen.getByTestId('image-models-toggle')).toHaveClass('flex-1')
    const before = slot.getBoundingClientRect()
    const cardHeight = card.getBoundingClientRect().height
    expect(before.height).toBe(36)
    const cardStyle = getComputedStyle(card)
    expect(card.getBoundingClientRect().bottom - before.bottom).toBeCloseTo(
      parseFloat(cardStyle.paddingBottom) + parseFloat(cardStyle.borderBottomWidth),
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
    expect(screen.getAllByRole('button', { name: 'Stop' })).toHaveLength(1)
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
    expect(Math.max(...rightEdges) - Math.min(...rightEdges)).toBeLessThanOrEqual(
      1
    )
    expect(card.getBoundingClientRect().width).toBeCloseTo(initial.width, 1)
    expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight)
    expect(panel).toHaveClass(
      'duration-250',
      'ease-out',
      'motion-reduce:animate-none'
    )
    expect(scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth)
  })
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
    const download = within(available).getByRole('button', {
      name: 'Download',
    })
    const remove = within(installed).getByRole('button', { name: 'Remove' })

    expect(within(installed).queryByText('Good fit')).toBeNull()
    expect(within(installed).queryByText(/GB/)).toBeNull()
    expect(within(available).getByText('Good fit')).toBeVisible()
    expect(within(available).getByText(/GB/)).toBeVisible()
    for (const subtitle of screen.getAllByTestId('image-model-subtitle')) {
      expectOneLine(subtitle)
    }
    const installedSubtitle = within(installed).getByTestId(
      'image-model-subtitle'
    )
    const installedControls = within(installed).getByTestId(
      `artifact-${Q4_ID}`
    )
    expect(
      installedControls.getBoundingClientRect().top -
        installedSubtitle.getBoundingClientRect().bottom
    ).toBeGreaterThanOrEqual(10)
    expect(run.getBoundingClientRect().height).toBe(28)
    expect(download.getBoundingClientRect().height).toBe(28)
    expect(remove.getBoundingClientRect().width).toBe(24)
    expect(remove.getBoundingClientRect().height).toBe(24)
    expect(run.querySelector('svg')).toBeNull()

    const quantTrigger = within(installed).getByRole('button', {
      name: /Select/,
    })
    const quantText = within(quantTrigger).getByText('Q4_K_M')
    expect(getComputedStyle(quantText).backgroundColor).toBe(
      'rgba(0, 0, 0, 0)'
    )

    const channels = getComputedStyle(run).backgroundColor.match(/\d+(?:\.\d+)?/g)
    expect(channels).not.toBeNull()
    expect(channels!.slice(0, 3).every((channel) => Number(channel) < 80)).toBe(
      true
    )
    expectNoHorizontalOverflow(view.container)
  })
})
