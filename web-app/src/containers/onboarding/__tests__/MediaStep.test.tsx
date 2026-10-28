import '@/test/telemetry-ready'
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import posthog from 'posthog-js'

import {
  makeCatalog,
  makeFilesFor,
  makeStatus,
  Z_IMAGE,
} from '@/lib/diffusion/__tests__/image-fixtures'
import {
  diffusionDownloadTaskId,
  listInstalledArtifacts,
} from '@/lib/diffusion/models'
import type { HardwareProfile } from '@/lib/hardware-tier'
import type { DiffusionModelFile } from '@/services/diffusion/types'
import type { DiffusionCatalogFamily } from '@/services/diffusion-catalog-registry'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { useOnboardingStore } from '@/stores/onboarding-store'

const mocks = vi.hoisted(() => ({
  media: true,
  hardware: { profile: null as unknown, ready: true },
}))

vi.mock('posthog-js', () => ({
  default: { capture: vi.fn() },
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key} ${Object.values(vars).join(' ')}` : key,
  }),
}))
vi.mock('@/lib/platform/const', () => ({
  PlatformFeatures: new Proxy(
    {},
    { get: (_target, key) => (key === 'mediaGeneration' ? mocks.media : true) }
  ),
}))
vi.mock('@/hooks/useHardwareTier', () => ({
  useHardwareTier: () => mocks.hardware,
}))

import { MediaStep } from '../steps/MediaStep'
import { useMediaCardCount } from '../steps/mediaAvailability'

const GIB_MIB = 1024

/** A machine whose memory budget is `gib` GiB of dedicated VRAM. */
const machine = (gib: number): HardwareProfile => ({
  tier: 'vram_16',
  memoryKind: 'vram',
  budgetMib: gib * GIB_MIB,
  systemRamMib: gib * GIB_MIB,
  vramMib: gib * GIB_MIB,
  hardCeiling: false,
})

// About 23 GB resident at its default size: no on 16 GB, tight on 28 GB.
const LTX: DiffusionCatalogFamily = {
  ...Z_IMAGE,
  id: 'ltx-2',
  name: 'LTX-2.3 Distilled',
  modality: 'video',
  transformer: {
    repo: 'unsloth/LTX-2.3-GGUF',
    quants: [
      {
        id: 'q4_k_m',
        label: 'Q4_K_M',
        filename: 'ltx-2.3-22b-distilled-Q4_K_M.gguf',
        bytes: 14_000_000_000,
        recommended: true,
      },
    ],
  },
  vae: {
    repo: 'unsloth/LTX-2.3-GGUF',
    filename: 'vae/ltx-2.3-video-vae.safetensors',
    bytes: 1_400_000_000,
  },
  text_encoders: [
    {
      repo: 'unsloth/gemma-3-12b-it-GGUF',
      filename: 'gemma-3-12b-it-Q4_K_M.gguf',
      bytes: 7_400_000_000,
      field: 'llm',
    },
  ],
  defaults: { ...Z_IMAGE.defaults, width: 768, height: 512 },
}

const catalog = makeCatalog([Z_IMAGE, LTX])

function onDisk(files: DiffusionModelFile[]) {
  useImageGenerationStore.setState({
    modelFiles: files,
    installedArtifacts: listInstalledArtifacts(catalog, files),
  })
}

const named = (event: string) =>
  vi
    .mocked(posthog.capture)
    .mock.calls.filter(([name]) => name === event)
    .map(([, props]) => props as Record<string, unknown>)

const card = (title: string) =>
  screen.getByRole('article', { name: title }) as HTMLElement

describe('media step', () => {
  const next = vi.fn()
  const goTo = vi.fn()
  const handOff = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mocks.media = true
    mocks.hardware = { profile: machine(64), ready: true }
    useImageGenerationStore.getState().reset()
    useImageGenerationStore.setState({
      catalog,
      status: makeStatus({ install: { state: 'not-installed' } }),
      hostBackendId: 'macos-arm64',
      hostBackendResolved: true,
    })
    onDisk([])
    useOnboardingStore.getState().reset()
    useOnboardingStore.getState().begin('full', 'media')
  })

  const renderStep = () =>
    render(<MediaStep next={next} goTo={goTo} handOff={handOff} />)

  it('offers an image and a video model with their download and memory', () => {
    renderStep()

    const image = card('Z-Image Turbo')
    const video = card('LTX-2.3 Distilled')
    expect(image).toHaveTextContent('onboarding-media:purpose.image')
    // 4.0 + 0.3 + 2.5 GB of files; about 7.8 GiB resident at one megapixel.
    expect(image).toHaveTextContent(
      'onboarding-media:size.download 6.3 · onboarding-media:memory 8'
    )
    expect(video).toHaveTextContent('onboarding-media:purpose.video')
    expect(video).toHaveTextContent(
      'onboarding-media:size.download 21.2 · onboarding-media:memory 22'
    )
    expect(screen.queryByText('onboarding-media:caution')).toBeNull()
    expect(renderHook(() => useMediaCardCount()).result.current).toBe(2)
  })

  it('marks each card with its family’s logo', () => {
    renderStep()

    // An <img>, or a CSS mask for a single-colour mark.
    expect(
      card('Z-Image Turbo').querySelector('.ob-media-logo')?.innerHTML
    ).toContain('/svg/z-image.svg')
    expect(
      card('LTX-2.3 Distilled').querySelector('.ob-media-logo')?.innerHTML
    ).toContain('/svg/lightricks.svg')
  })

  it('hides a model that will not fit and cautions about one that is tight', () => {
    mocks.hardware = { profile: machine(16), ready: true }
    const { unmount } = renderStep()
    expect(card('Z-Image Turbo')).toBeInTheDocument()
    expect(
      screen.queryByRole('article', { name: 'LTX-2.3 Distilled' })
    ).toBeNull()
    expect(renderHook(() => useMediaCardCount()).result.current).toBe(1)
    unmount()

    mocks.hardware = { profile: machine(28), ready: true }
    renderStep()
    expect(card('LTX-2.3 Distilled')).toHaveTextContent(
      'onboarding-media:caution'
    )
    expect(card('Z-Image Turbo')).not.toHaveTextContent(
      'onboarding-media:caution'
    )
  })

  it('offers nothing without a build for this host, the feature or the memory', () => {
    const count = renderHook(() => useMediaCardCount())
    expect(count.result.current).toBe(2)

    act(() => useImageGenerationStore.setState({ hostBackendId: null }))
    count.rerender()
    expect(count.result.current).toBe(0)

    // An engine already installed needs no build from the manifest.
    act(() => useImageGenerationStore.setState({ status: makeStatus() }))
    count.rerender()
    expect(count.result.current).toBe(2)

    mocks.hardware = { profile: null, ready: false }
    count.rerender()
    expect(count.result.current).toBe(0)

    mocks.hardware = { profile: machine(64), ready: true }
    mocks.media = false
    count.rerender()
    expect(count.result.current).toBe(0)
  })

  it('queues a model behind the chat download and takes it off again', () => {
    useOnboardingStore.getState().enqueue({
      key: 'chat',
      kind: 'chat',
      title: 'Qwen3.5 4B',
      taskId: 'Qwen3.5-4B-Q4_K_M',
      phase: 'running',
    })
    renderStep()
    // The chat model's download is not a media choice.
    expect(
      screen.getByRole('button', { name: /onboarding-media:skip/ })
    ).toBeInTheDocument()

    fireEvent.click(
      screen.getAllByRole('button', { name: /onboarding-media:queue.add/ })[0]
    )

    expect(useOnboardingStore.getState().jobs).toEqual([
      expect.objectContaining({ key: 'chat' }),
      {
        key: 'z-image',
        kind: 'image',
        title: 'Z-Image Turbo',
        taskId: diffusionDownloadTaskId('z-image:q4_k_m'),
        artifactId: 'z-image:q4_k_m',
        totalBytes: 6_800_000_000,
        phase: 'queued',
      },
    ])
    const queued = screen.getByRole('button', {
      name: /onboarding-media:queue.queued/,
    })
    expect(queued).toHaveAttribute('aria-pressed', 'true')
    expect(
      screen.getByText('onboarding-media:order Qwen3.5 4B → Z-Image Turbo')
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /onboarding:continue/ })
    ).toBeInTheDocument()

    fireEvent.click(queued)

    expect(useOnboardingStore.getState().jobs.map((job) => job.key)).toEqual([
      'chat',
    ])
    expect(screen.queryByText(/onboarding-media:order/)).toBeNull()
    fireEvent.click(
      screen.getByRole('button', { name: /onboarding-media:skip/ })
    )
    expect(next).toHaveBeenCalledWith('skip')
    const queuedEvents = named('onboarding_media_queued')
    expect(queuedEvents).toHaveLength(2)
    expect(queuedEvents[0]).toMatchObject({
      media_family: 'z-image',
      queue_action: 'added',
    })
    expect(queuedEvents[1]).toMatchObject({
      media_family: 'z-image',
      queue_action: 'removed',
    })
  })

  it('continues with media queued, and says what a queued job is doing', () => {
    renderStep()
    fireEvent.click(
      screen.getAllByRole('button', { name: /onboarding-media:queue.add/ })[1]
    )
    expect(useOnboardingStore.getState().jobs[0]).toMatchObject({
      key: 'ltx-2',
      kind: 'video',
      artifactId: 'ltx-2:q4_k_m',
    })

    act(() => useOnboardingStore.getState().setJobPhase('ltx-2', 'running'))
    expect(
      screen.getByRole('button', { name: /onboarding-media:queue.downloading/ })
    ).toHaveAttribute('aria-pressed', 'true')
    act(() => useOnboardingStore.getState().setJobPhase('ltx-2', 'failed'))
    expect(
      screen.getByRole('button', { name: /onboarding-media:queue.interrupted/ })
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /onboarding:continue/ }))
    expect(next).toHaveBeenCalledWith('continue')
  })

  it('marks a model already on disk as downloaded and queues nothing for it', () => {
    onDisk(makeFilesFor(Z_IMAGE, 'q4_k_m'))
    renderStep()

    const image = card('Z-Image Turbo')
    expect(image).toHaveTextContent('onboarding-media:queue.downloaded')
    expect(image).toHaveTextContent('onboarding-media:size.onDisk 6.3')
    expect(image.querySelector('button')).toBeNull()
    expect(
      screen.getAllByRole('button', { name: /onboarding-media:queue.add/ })
    ).toHaveLength(1)
    expect(useOnboardingStore.getState().jobs).toEqual([])
  })

  it('offers an installed quant that runs here over the recommended one', () => {
    onDisk(makeFilesFor(Z_IMAGE, 'q8_0'))
    renderStep()

    expect(card('Z-Image Turbo')).toHaveTextContent(
      'onboarding-media:queue.downloaded'
    )
  })
})
