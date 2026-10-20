import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImageArtifactState } from '@/hooks/useImageArtifact'
import type { DiffusionCatalogFamily } from '@/services/diffusion-catalog-registry'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  selected: [] as Array<[string, string | null]>,
  artifacts: {} as Record<string, Partial<ImageArtifactState>>,
  download: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  installed: [] as Array<{ id: string; family: string }>,
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}))

vi.mock('@/hooks/useHardwareTier', () => ({
  useHardwareTier: () => ({ profile: null }),
}))

vi.mock('@/hooks/useVideoSetting', () => ({
  useSelectedArtifact: (modality: string) => ({
    selectedArtifactId: null,
    setSelectedArtifactId: (id: string | null) =>
      mocks.selected.push([modality, id]),
  }),
}))

vi.mock('@/stores/image-generation-store', () => ({
  useImageGenerationStore: (
    selector: (s: {
      generating: boolean
      installedArtifacts: typeof mocks.installed
    }) => unknown
  ) => selector({ generating: false, installedArtifacts: mocks.installed }),
}))

vi.mock('@/hooks/useImageArtifact', () => ({
  useImageArtifact: (id: string): ImageArtifactState =>
    ({
      id,
      totalBytes: 4 * 1024 ** 3,
      installed: null,
      complete: false,
      downloading: false,
      progress: 0,
      fit: 'ok',
      download: mocks.download,
      cancelDownload: vi.fn(),
      remove: mocks.remove,
      ...mocks.artifacts[id],
    }) as ImageArtifactState,
}))

import { MediaFamilyDetailPanel } from '../MediaFamilyDetailPanel'

const imageFamily = {
  id: 'z-image',
  name: 'Z-Image Turbo',
  developer: 'Tongyi-MAI',
  description: 'Fast 6B text-to-image model.',
  license: 'apache-2.0',
  modality: 'image',
  engines: ['sdcpp'],
  transformer: {
    repo: 'unsloth/Z-Image-Turbo-GGUF',
    quants: [
      { id: 'q4_k_m', label: 'Q4_K_M', filename: 'z-q4.gguf', bytes: 1 },
      { id: 'q8_0', label: 'Q8_0', filename: 'z-q8.gguf', bytes: 2 },
    ],
  },
  text_encoders: [],
  defaults: { steps: 8, cfg_scale: 1, width: 1024, height: 768 },
  ranges: { steps: [1, 50], dims: [256, 2048], dim_multiple: 64 },
  capabilities: { negative_prompt: false, guidance: false, workflows: [] },
} as unknown as DiffusionCatalogFamily

const videoFamily = {
  ...imageFamily,
  id: 'wan-2.2-ti2v-5b',
  name: 'Wan 2.2',
  modality: 'video',
  transformer: {
    repo: 'QuantStack/Wan2.2-TI2V-5B-GGUF',
    quants: [{ id: 'q4', label: 'Q4', filename: 'wan-q4.gguf', bytes: 1 }],
  },
  video: {
    fps: 24,
    frame_step: 4,
    frame_offset: 1,
    frames: 49,
    frame_range: [1, 121],
    resolution_presets: [[832, 480]],
  },
} as unknown as DiffusionCatalogFamily

const quantRow = (id: string) => screen.getByTestId(`media-quant-${id}`)

/** Open the disclosure and pick `id`, as a person choosing another quant. */
async function pickQuant(id: string) {
  await userEvent.click(
    screen.getByRole('button', { name: 'hub:downloadOptions' })
  )
  await userEvent.click(screen.getByTestId(`media-quant-option-${id}`))
}

describe('MediaFamilyDetailPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.selected = []
    mocks.artifacts = {}
    mocks.installed = []
    globalThis.fetch = vi.fn() as unknown as typeof fetch
  })

  it('asks for a selection when there is none', () => {
    render(<MediaFamilyDetailPanel family={null} />)

    expect(screen.getByText('hub:selectModel')).toBeInTheDocument()
  })

  it('shows the family, links its repo and opens on one quant with every quant behind the disclosure', async () => {
    render(<MediaFamilyDetailPanel family={imageFamily} />)

    expect(
      screen.getByRole('heading', { name: 'Z-Image Turbo' })
    ).toBeInTheDocument()
    expect(screen.getByText('Fast 6B text-to-image model.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /hub:openOnWeb/ })).toHaveAttribute(
      'href',
      'https://huggingface.co/unsloth/Z-Image-Turbo-GGUF'
    )
    // Collapsed on the recommended quant: on unknown hardware every quant
    // fits, and the largest that fits is recommended.
    const row = quantRow('z-image:q8_0')
    expect(within(row).getByText('Q8_0')).toBeVisible()
    expect(within(row).getByText('images:model.recommended')).toBeVisible()
    expect(
      screen.queryByTestId('media-quant-z-image:q4_k_m')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('media-quant-option-z-image:q4_k_m')
    ).not.toBeInTheDocument()

    await userEvent.click(
      screen.getByRole('button', { name: 'hub:downloadOptions' })
    )
    const q4 = screen.getByTestId('media-quant-option-z-image:q4_k_m')
    expect(within(q4).getByText('Q4_K_M')).toBeVisible()
    expect(
      within(q4).getByText('images:model.sizeGb {"size":"4.00"}')
    ).toBeVisible()
    expect(
      screen
        .getByTestId('media-quant-option-z-image:q8_0')
        .getAttribute('aria-current')
    ).toBe('true')

    // Picking one closes the list and makes it the quant the row acts on.
    await userEvent.click(q4)
    expect(within(quantRow('z-image:q4_k_m')).getByText('Q4_K_M')).toBeVisible()
    expect(
      screen.queryByTestId('media-quant-option-z-image:q4_k_m')
    ).not.toBeInTheDocument()
  })

  it('opens on the quant that has files on disk', () => {
    mocks.installed = [{ id: 'z-image:q4_k_m', family: 'z-image' }]
    render(<MediaFamilyDetailPanel family={imageFamily} />)

    expect(quantRow('z-image:q4_k_m')).toBeVisible()
  })

  it('links the repo on Hugging Face instead of fetching its README', () => {
    render(<MediaFamilyDetailPanel family={imageFamily} />)

    expect(screen.getByRole('link', { name: /hub:openOnWeb/ })).toHaveAttribute(
      'href',
      'https://huggingface.co/unsloth/Z-Image-Turbo-GGUF'
    )
    expect(screen.queryByText('hub:readme')).not.toBeInTheDocument()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('downloads a quant and makes it the Images selection', async () => {
    render(<MediaFamilyDetailPanel family={imageFamily} />)

    await pickQuant('z-image:q4_k_m')
    await userEvent.click(
      within(quantRow('z-image:q4_k_m')).getByRole('button', {
        name: 'images:model.download',
      })
    )

    expect(mocks.selected).toEqual([['image', 'z-image:q4_k_m']])
    expect(mocks.download.mock.calls).toHaveLength(1)
  })

  it('opens a downloaded quant in the Images studio', async () => {
    mocks.artifacts['z-image:q4_k_m'] = {
      complete: true,
      installed: {
        id: 'z-image:q4_k_m',
        family: 'z-image',
        quantId: 'q4_k_m',
        bytes: 1,
        complete: true,
        missing: [],
      },
    }
    mocks.installed = [{ id: 'z-image:q4_k_m', family: 'z-image' }]
    render(<MediaFamilyDetailPanel family={imageFamily} />)

    await userEvent.click(
      within(quantRow('z-image:q4_k_m')).getByRole('button', {
        name: 'hub:openInImages',
      })
    )

    expect(mocks.selected).toEqual([['image', 'z-image:q4_k_m']])
    expect(mocks.navigate.mock.calls).toEqual([[{ to: '/images/' }]])
  })

  it('opens a downloaded video quant in the Video studio', async () => {
    mocks.artifacts['wan-2.2-ti2v-5b:q4'] = { complete: true }
    render(<MediaFamilyDetailPanel family={videoFamily} />)

    await userEvent.click(
      screen.getByRole('button', { name: 'hub:openInVideo' })
    )

    expect(mocks.selected).toEqual([['video', 'wan-2.2-ti2v-5b:q4']])
    expect(mocks.navigate.mock.calls).toEqual([[{ to: '/videos/' }]])
  })

  it('removes a quant with files on disk after confirmation', async () => {
    mocks.artifacts['z-image:q8_0'] = {
      complete: false,
      installed: {
        id: 'z-image:q8_0',
        family: 'z-image',
        quantId: 'q8_0',
        bytes: 1,
        complete: false,
        missing: ['z-q8.gguf'],
      },
    }
    mocks.installed = [{ id: 'z-image:q8_0', family: 'z-image' }]
    render(<MediaFamilyDetailPanel family={imageFamily} />)

    // A half-downloaded quant is the one the panel opens on; it offers to
    // finish, and to be removed.
    const row = quantRow('z-image:q8_0')
    expect(
      within(row).getByRole('button', { name: 'images:model.finishDownload' })
    ).toBeVisible()
    await userEvent.click(
      within(row).getByRole('button', { name: 'images:model.remove' })
    )
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'images:model.remove',
      })
    )

    expect(mocks.remove.mock.calls).toHaveLength(1)
  })

  it('lists what an image family can do and a video family’s frame rate', () => {
    const { unmount } = render(<MediaFamilyDetailPanel family={imageFamily} />)
    expect(screen.getByText('images:workflow.create.label')).toBeVisible()
    expect(screen.getByText('images:workflow.inpaint.label')).toBeVisible()
    expect(screen.getByText('1024×768')).toBeVisible()
    expect(screen.queryByText('hub:frameRate')).not.toBeInTheDocument()
    unmount()

    render(<MediaFamilyDetailPanel family={videoFamily} />)
    expect(screen.getByText('24 fps')).toBeVisible()
    expect(screen.queryByText('hub:capabilities')).not.toBeInTheDocument()
  })
})
