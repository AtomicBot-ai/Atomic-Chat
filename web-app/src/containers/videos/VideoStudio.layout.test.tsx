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
  expectSameHeight,
  settle,
  setFontSize,
  setTheme,
  withTranslations,
  XL_FONT_SIZE,
} from '@/test/layout'
import { seedServiceHub } from '@/test/service-hub'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { useVideoGenerationStore } from '@/stores/video-generation-store'
import { ImageSizeControl } from '@/containers/images/ImageSizeControl'
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
vi.mock('@/lib/notifications', () => ({ notifyWhenAway: vi.fn() }))
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
    // LTX's own numbers, so picking LTX keeps them.
    recipeFamily: 'ltx-2',
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
      expect(duration.querySelector('span')).toHaveTextContent('5.0s')
      expect(screen.getByTestId('video-duration-frames')).toHaveTextContent(
        '121 frames'
      )
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

  it.each([
    { fontSize: DEFAULT_FONT_SIZE, theme: 'light' as const },
    { fontSize: XL_FONT_SIZE, theme: 'dark' as const },
  ])(
    'draws Resolution and Duration as the Images pills, with the secondary readout on the right, at $fontSize/$theme',
    async ({ fontSize, theme }) => {
      setFontSize(fontSize)
      setTheme(theme)
      render(
        withTranslations(
          <div className="flex gap-4">
            <div className="flex h-[900px] w-[340px] overflow-hidden">
              <VideoPromptForm />
            </div>
            {/* The Images column's own Resolution pill, as the reference. */}
            <div className="w-[300px]">
              <ImageSizeControl
                value={{
                  width: 1024,
                  height: 1024,
                  aspect: 'square',
                  portrait: false,
                }}
                constraints={{ minDim: 256, maxDim: 2048, dimMultiple: 16 }}
                onChange={() => {}}
              />
            </div>
          </div>
        )
      )
      await act(async () => {
        await settle()
      })

      const reference = screen.getByTestId('image-size-preset')
      const resolution = screen.getByTestId('video-resolution')
      const duration = screen.getByTestId('video-duration')
      // The seed box and the model trigger are the Images components; the
      // two video pills must stand at their height, not shrink to a line.
      expectSameHeight([
        reference,
        resolution,
        duration,
        document.getElementById('video-seed')!,
        screen.getByTestId('image-models-toggle'),
      ])
      expect(resolution.getBoundingClientRect().height).toBeGreaterThan(30)

      const ref = getComputedStyle(reference)
      for (const pill of [resolution, duration]) {
        const style = getComputedStyle(pill)
        expect(style.borderTopLeftRadius).toBe(ref.borderTopLeftRadius)
        expect(style.borderTopWidth).toBe(ref.borderTopWidth)
        expect(style.fontSize).toBe(ref.fontSize)
        expect(style.paddingLeft).toBe(ref.paddingLeft)
        expect(style.paddingRight).toBe(ref.paddingRight)
      }

      // Value left, a muted readout at the right edge — the megapixels on
      // Resolution as on Images, the frame count on Duration.
      const referenceReadout = reference.querySelectorAll('span')[1]!
      const megapixels = screen.getByTestId('video-resolution-megapixels')
      const frames = screen.getByTestId('video-duration-frames')
      expect(resolution).toHaveTextContent('704 × 1216 (portrait)')
      expect(megapixels).toHaveTextContent('0.9 MP')
      expect(duration).toHaveTextContent('5.0s')
      expect(frames).toHaveTextContent('121 frames')
      for (const [pill, readout] of [
        [resolution, megapixels],
        [duration, frames],
      ] as const) {
        expectOneLine(pill.querySelector('span')!)
        expectOneLine(readout)
        expect(getComputedStyle(readout).fontSize).toBe(
          getComputedStyle(referenceReadout).fontSize
        )
        expect(getComputedStyle(readout).color).toBe(
          getComputedStyle(referenceReadout).color
        )
        const chevron = pill.querySelector('svg')!.getBoundingClientRect()
        const gap = chevron.left - readout.getBoundingClientRect().right
        const referenceGap =
          reference.querySelector('svg')!.getBoundingClientRect().left -
          referenceReadout.getBoundingClientRect().right
        expect(gap).toBeCloseTo(referenceGap, 0)
      }
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
