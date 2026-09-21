import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  status: {
    model: {
      state: 'loaded',
      loaded: { modelId: 'z-image:q4_k_m', displayName: 'Z-Image Turbo' },
    },
  },
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
    complete: id === 'z-image:q4_k_m',
    loaded: state.status.model.loaded?.modelId === id,
    loading: state.loadingArtifactId === id,
    unloading: state.unloadingArtifactId === id,
    load: state.load,
    family: {
      id: 'z-image',
      name: 'Z-Image Turbo',
      developer: 'Example',
    },
    quant: { label: 'Q4_K_M' },
  }),
}))
vi.mock('@/hooks/useImageSetting', () => ({
  useImageSetting: (selector: (value: typeof state) => unknown) =>
    selector(state),
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
    state.status.model = {
      state: 'loaded',
      loaded: { modelId: 'z-image:q4_k_m', displayName: 'Z-Image Turbo' },
    }
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
