import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  status: {
    model: {
      state: 'loaded',
      loaded: { modelId: 'z-image:q4_k_m', displayName: 'Z-Image Turbo' },
    },
  },
  loadingArtifactId: null as string | null,
  workflow: 'create' as 'create' | 'edit',
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/hooks/useImageForm', () => ({
  useImageForm: (
    selector: (value: { workflow: 'create' | 'edit' }) => unknown
  ) =>
    selector({ workflow: state.workflow }),
}))
vi.mock('@/hooks/useImageArtifact', () => ({
  useImageArtifact: () => ({
    loading: false,
    family: {
      id: 'z-image',
      name: 'Z-Image Turbo',
      developer: 'Example',
    },
    quant: { label: 'Q4_K_M' },
  }),
}))
vi.mock('@/stores/image-generation-store', () => ({
  useImageGenerationStore: (selector: (value: typeof state) => unknown) =>
    selector(state),
}))
vi.mock('../ImageModelSelector', () => ({
  ImageModelSelector: () => <div data-testid="image-model-selector" />,
}))

import { ImageModelPicker } from '../ImageModelPicker'

describe('ImageModelPicker', () => {
  it('does not duplicate model Stop beside the top selector', () => {
    render(<ImageModelPicker open={false} onOpenChange={vi.fn()} />)

    expect(screen.getByTestId('image-models-toggle')).toHaveTextContent(
      'Z-Image Turbo'
    )
    expect(
      screen.queryByRole('button', { name: 'images:model.unload' })
    ).not.toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(1)
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
    state.workflow = 'create'
  })
})
