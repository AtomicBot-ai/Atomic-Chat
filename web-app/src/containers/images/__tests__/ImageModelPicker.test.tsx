import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  status: {
    model: {
      state: 'loaded',
      loaded: {
        modelId: 'z-image:q4_k_m',
        displayName: 'Z-Image Turbo',
        modality: 'image',
      } as {
        modelId: string
        displayName: string
        modality: 'image' | 'video'
      } | null,
    },
  },
  videoSelectedArtifactId: null as string | null,
  setVideoSelectedArtifactId: vi.fn(),
  loadingArtifactId: null as string | null,
  unloadingArtifactId: null as string | null,
  selectedArtifactId: 'z-image:q4_k_m' as string | null,
  generating: false,
  unloadModel: vi.fn(async () => undefined),
  setSelectedArtifactId: vi.fn(),
  load: vi.fn(async () => undefined),
  workflow: 'create' as 'create' | 'edit',
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/hooks/useImageForm', () => ({
  useImageForm: (
    selector: (value: { workflow: 'create' | 'edit' }) => unknown
  ) => selector({ workflow: state.workflow }),
}))
vi.mock('@/hooks/useImageArtifact', () => ({
  useImageArtifact: (id: string) => ({
    complete: id === 'z-image:q4_k_m' || id === 'ltx-2:q4_k_m',
    loaded: state.status.model.loaded?.modelId === id,
    loading: state.loadingArtifactId === id,
    unloading: state.unloadingArtifactId === id,
    load: state.load,
    family: id.startsWith('ltx-2')
      ? {
          id: 'ltx-2',
          name: 'LTX-2.3 Distilled',
          developer: 'Lightricks',
          modality: 'video',
        }
      : id
        ? {
            id: 'z-image',
            name: 'Z-Image Turbo',
            developer: 'Example',
            modality: 'image',
          }
        : null,
    quant: { label: 'Q4_K_M' },
  }),
}))
vi.mock('@/hooks/useImageSetting', () => ({
  useImageSetting: (selector: (value: typeof state) => unknown) =>
    selector(state),
}))
vi.mock('@/hooks/useVideoSetting', () => ({
  useSelectedArtifact: (modality: 'image' | 'video') =>
    modality === 'video'
      ? {
          selectedArtifactId: state.videoSelectedArtifactId,
          setSelectedArtifactId: state.setVideoSelectedArtifactId,
        }
      : {
          selectedArtifactId: state.selectedArtifactId,
          setSelectedArtifactId: state.setSelectedArtifactId,
        },
}))
vi.mock('@/stores/image-generation-store', () => ({
  useImageGenerationStore: Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state }
  ),
}))
vi.mock('sonner', () => ({
  toast: { loading: vi.fn(), success: vi.fn(), error: vi.fn() },
}))
vi.mock('../ImageModelSelector', () => ({
  ImageModelSelector: () => <div data-testid="image-model-selector" />,
}))

import { ImageModelPicker } from '../ImageModelPicker'

describe('ImageModelPicker', () => {
  beforeEach(() => {
    state.workflow = 'create'
    state.loadingArtifactId = null
    state.unloadingArtifactId = null
    state.selectedArtifactId = 'z-image:q4_k_m'
    state.videoSelectedArtifactId = null
    state.status.model = {
      state: 'loaded',
      loaded: {
        modelId: 'z-image:q4_k_m',
        displayName: 'Z-Image Turbo',
        modality: 'image',
      },
    }
  })

  it('does not show a resident video model as the Images page\'s model, nor an image one as the Video page\'s', () => {
    state.status.model = {
      state: 'loaded',
      loaded: {
        modelId: 'ltx-2:q4_k_m',
        displayName: 'LTX-2.3 Distilled',
        modality: 'video',
      },
    }
    const { unmount } = render(
      <ImageModelPicker open={false} onOpenChange={vi.fn()} />
    )
    // The Images page falls back to its own installed selection.
    expect(screen.getByTestId('image-models-toggle')).toHaveTextContent(
      'Z-Image Turbo'
    )
    expect(screen.getByTestId('image-model-runtime-indicator')).toHaveAttribute(
      'data-phase',
      'idle'
    )
    unmount()

    render(
      <ImageModelPicker open={false} onOpenChange={vi.fn()} modality="video" />
    )
    expect(screen.getByTestId('image-models-toggle')).toHaveTextContent(
      'LTX-2.3 Distilled'
    )
    expect(screen.getByTestId('image-model-runtime-indicator')).toHaveAttribute(
      'data-phase',
      'ready'
    )
  })

  it('shows the Video page\'s own selection, whatever the image workflow', () => {
    state.workflow = 'edit'
    state.status.model = { state: 'unloaded', loaded: null }
    state.videoSelectedArtifactId = 'ltx-2:q4_k_m'
    render(
      <ImageModelPicker open={false} onOpenChange={vi.fn()} modality="video" />
    )
    expect(screen.getByTestId('image-models-toggle')).toHaveTextContent(
      'LTX-2.3 Distilled'
    )
    expect(screen.getByTestId('image-model-runtime-indicator')).toHaveAttribute(
      'data-phase',
      'idle'
    )
  })

  it('uses a compact ready control instead of a second text Stop button', () => {
    render(<ImageModelPicker open={false} onOpenChange={vi.fn()} />)

    expect(screen.getByTestId('image-models-toggle')).toHaveTextContent(
      'Z-Image Turbo'
    )
    const indicator = screen.getByTestId('image-model-runtime-indicator')
    expect(indicator).toHaveAttribute('data-phase', 'ready')
    expect(indicator).toHaveAccessibleName('images:model.unload')
    expect(indicator).not.toHaveTextContent('images:model.unload')
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })

  it('keeps Starting out of the pill and in the reserved status slot', () => {
    state.status.model = { state: 'loading', loaded: null }
    state.loadingArtifactId = 'z-image:q4_k_m'
    render(<ImageModelPicker open={false} onOpenChange={vi.fn()} />)

    const toggle = screen.getByTestId('image-models-toggle')
    expect(toggle).toHaveTextContent('Z-Image Turbo')
    expect(toggle).toHaveTextContent('Q4_K_M')
    expect(toggle).not.toHaveTextContent('images:model.loading')
    const indicator = screen.getByTestId('image-model-runtime-indicator')
    expect(indicator).toHaveAttribute('data-phase', 'starting')
    expect(indicator.querySelector('svg')).not.toBeNull()
  })

  it('shows selection required when the resident model cannot run the workflow', () => {
    state.workflow = 'edit'
    render(<ImageModelPicker open={false} onOpenChange={vi.fn()} />)

    expect(screen.getByTestId('image-models-toggle')).toHaveTextContent(
      'images:model.select'
    )
    expect(screen.getByTestId('image-models-toggle')).not.toHaveTextContent(
      'Z-Image Turbo'
    )
    expect(
      screen.queryByTestId('image-model-unsupported')
    ).not.toBeInTheDocument()
  })
})
