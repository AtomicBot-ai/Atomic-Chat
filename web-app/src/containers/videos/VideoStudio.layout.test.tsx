import { act, fireEvent, render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_VIDEO_FORM, useVideoForm } from '@/hooks/useVideoForm'
import { useImageSetting } from '@/hooks/useImageSetting'
import { useVideoSetting } from '@/hooks/useVideoSetting'
import {
  makeCatalog,
  makeFakeDiffusion,
  makeFilesFor,
  MODELS_ROOT,
  Z_IMAGE,
} from '@/lib/diffusion/__tests__/image-fixtures'
import {
  LTX_2,
  LTX_Q4_ID,
  makeVideoCapabilities,
  makeVideoLoadedStatus,
} from '@/lib/diffusion/__tests__/video-fixtures'
import { listInstalledArtifacts } from '@/lib/diffusion/models'
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
import { useVideoGenerationStore } from '@/stores/video-generation-store'
import { VideoPromptForm } from './VideoPromptForm'

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
vi.mock('@/lib/notifications', () => ({ notifyThreadCompleted: vi.fn() }))
vi.mock('@/lib/telemetry-queue', () => ({ queuedCapture: vi.fn() }))
vi.mock('@/hooks/useHardwareTier', () => ({
  useHardwareTier: () => ({
    tier: 'vram_8',
    ready: true,
    profile: {
      tier: 'vram_8',
      memoryKind: 'vram',
      budgetMib: 24 * 1024,
      systemRamMib: 64 * 1024,
      vramMib: 24 * 1024,
      hardCeiling: false,
    },
  }),
}))

const frame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

const ltxFiles = makeFilesFor(LTX_2, 'q4_k_m')

async function seedVideoStudio() {
  localStorage.clear()
  await useVideoForm.persist.rehydrate()
  await useImageSetting.persist.rehydrate()
  await useVideoSetting.persist.rehydrate()
  useVideoForm.setState({
    ...DEFAULT_VIDEO_FORM,
    prompt: 'A lighthouse at dusk, waves rolling in',
    width: 704,
    height: 1216,
    frames: 121,
  })
  useImageSetting.setState({ advancedOpen: false })
  useVideoSetting.setState({ selectedArtifactId: LTX_Q4_ID, advancedOpen: false })
  useImageGenerationStore.getState().reset()
  useVideoGenerationStore.getState().reset()
  const catalog = makeCatalog([Z_IMAGE, LTX_2])
  useImageGenerationStore.setState({
    catalog,
    modelFiles: ltxFiles,
    installedArtifacts: listInstalledArtifacts(catalog, ltxFiles),
    status: makeVideoLoadedStatus(),
    videoCapabilities: makeVideoCapabilities(),
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

describe('Video studio form geometry', () => {
  beforeEach(async () => {
    await page.viewport(1024, 1000)
    setTheme('light')
    await seedVideoStudio()
  })

  it.each([
    { fontSize: DEFAULT_FONT_SIZE, theme: 'light' as const },
    { fontSize: XL_FONT_SIZE, theme: 'dark' as const },
  ])(
    'keeps the resolution and duration pills on one line in the 340 px column at $fontSize/$theme',
    async ({ fontSize, theme }) => {
      setFontSize(fontSize)
      setTheme(theme)
      const view = render(
        withTranslations(
          <div className="flex h-[900px] w-[340px] overflow-hidden" data-testid="form-frame">
            <VideoPromptForm />
          </div>
        )
      )
      await act(async () => {
        await settle()
      })

      const resolution = screen.getByTestId('video-resolution')
      const duration = screen.getByTestId('video-duration')
      expect(resolution).toHaveTextContent('704 × 1216 (portrait)')
      expect(duration).toHaveTextContent('5.0s · 121 frames')
      expectOneLine(resolution.querySelector('span')!)
      expectOneLine(duration.querySelector('span')!)
      expect(screen.getByTestId('video-frame-rate')).toHaveTextContent('24 fps')
      expectOneLine(screen.getByTestId('video-frame-rate'))

      const scroller = screen.getByTestId('video-form-scroller')
      expect(scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth)
      expectNoHorizontalOverflow(view.container)
      // A distilled family: no negative prompt, no guidance knob.
      expect(screen.queryByText('Negative prompt')).toBeNull()
      expect(screen.queryByLabelText('Guidance')).toBeNull()
    }
  )

  it('opens Advanced at the card width, with the video API card, without a horizontal jump', async () => {
    render(
      withTranslations(
        <div className="flex w-[400px] overflow-hidden" data-testid="form-frame">
          <VideoPromptForm />
        </div>
      )
    )
    await act(async () => {
      await settle()
    })
    const frameElement = screen.getByTestId('form-frame')
    const scroller = screen.getByTestId('video-form-scroller')
    frameElement.style.height = `${scroller.scrollHeight}px`
    await act(async () => {
      await frame()
      await frame()
    })

    const card = screen.getByTestId('video-prompt-card')
    const initial = card.getBoundingClientRect()
    expect(getComputedStyle(scroller).scrollbarGutter).toContain('stable')

    fireEvent.click(screen.getByTestId('video-advanced-toggle'))
    const panel = await screen.findByTestId('video-advanced-panel')
    const rightEdges: number[] = []
    await act(async () => {
      for (let index = 0; index < 20; index += 1) {
        rightEdges.push(card.getBoundingClientRect().right)
        await frame()
      }
    })
    await act(async () => {
      await settle(panel)
    })

    expect(panel.getBoundingClientRect().height).toBeGreaterThan(100)
    expect(Math.max(...rightEdges) - Math.min(...rightEdges)).toBeLessThanOrEqual(1)
    expect(panel.getBoundingClientRect().width).toBeCloseTo(initial.width, 0)
    expect(card.getBoundingClientRect().width).toBeCloseTo(initial.width, 1)
    expect(scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth)

    const apiCard = screen.getByTestId('image-api-settings-card')
    expect(apiCard).toHaveAttribute('data-resource', 'videos')
    expect(screen.getByTestId('image-api-endpoint')).toHaveTextContent(/\/v1\/videos$/)
    expectNoHorizontalOverflow(apiCard)
  })
})
