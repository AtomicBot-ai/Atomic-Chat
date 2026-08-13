import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CatalogModel } from '@/services/models/types'

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', MockResizeObserver)
})

afterAll(() => {
  vi.unstubAllGlobals()
})

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/containers/ModelDownloadAction', () => ({
  ModelDownloadAction: ({
    variant,
  }: {
    variant: { model_id: string }
  }) => <button type="button">download {variant.model_id}</button>,
}))

vi.mock('@/containers/MlxModelDownloadAction', () => ({
  MlxModelDownloadAction: () => <button type="button">download mlx</button>,
}))

import { DownloadOptionsSelect } from '../DownloadOptionsSelect'

const GB = 1024 ** 3

const ggufModel = (): CatalogModel =>
  ({
    model_name: 'Qwen/Qwen3.5-4B-GGUF',
    developer: 'Qwen',
    num_quants: 3,
    quants: [
      {
        model_id: 'Qwen3.5-4B-Q2_K',
        path: 'q2.gguf',
        file_size: '1.20 GB',
      },
      {
        model_id: 'Qwen3.5-4B-Q4_K_M',
        path: 'q4.gguf',
        file_size: '2.50 GB',
      },
      {
        model_id: 'Qwen3.5-4B-Q8_0',
        path: 'q8.gguf',
        file_size: '400.00 GB',
      },
    ],
  }) as CatalogModel

const exoticQuantModel = (): CatalogModel =>
  ({
    model_name: 'prism-ml/Bonsai-27B-gguf',
    developer: 'prism-ml',
    num_quants: 4,
    quants: [
      { model_id: 'Bonsai-27B-F16', path: 'f16.gguf', file_size: '51.00 GB' },
      { model_id: 'Bonsai-27B-Q1_0', path: 'q1.gguf', file_size: '4.40 GB' },
      { model_id: 'Bonsai-27B-Q4_1', path: 'q4-1.gguf', file_size: '2.60 GB' },
      { model_id: 'Bonsai-27B-BF16', path: 'bf16.gguf', file_size: '7.70 GB' },
    ],
  }) as CatalogModel

describe('DownloadOptionsSelect', () => {
  it('preselects the default quantization rather than the first one', () => {
    render(<DownloadOptionsSelect model={ggufModel()} budgetBytes={16 * GB} />)

    expect(screen.getByText('Q4_K_M')).toBeInTheDocument()
    expect(screen.getByRole('button', { expanded: false })).toHaveClass(
      'bg-muted/40'
    )
    expect(screen.getByText('download Qwen3.5-4B-Q4_K_M')).toBeInTheDocument()
  })

  it('opens a repo without the house quant on a variant the device can run', () => {
    render(
      <DownloadOptionsSelect model={exoticQuantModel()} budgetBytes={24 * GB} />
    )

    expect(screen.getByText('download Bonsai-27B-Q1_0')).toBeInTheDocument()
    expect(screen.getByLabelText('Good fit')).toBeInTheDocument()
    expect(screen.queryByText('Good fit')).not.toBeInTheDocument()
    expect(screen.queryByText('Too large')).not.toBeInTheDocument()
  })

  it('steps down from a default the device cannot hold', () => {
    // Q4_K_M is the house default at 2.50 GB, out of reach on a 2 GB device.
    render(<DownloadOptionsSelect model={ggufModel()} budgetBytes={2 * GB} />)

    expect(screen.getByText('download Qwen3.5-4B-Q2_K')).toBeInTheDocument()
  })

  it('lists every quant with its size once expanded', async () => {
    const user = userEvent.setup()
    const model = ggufModel()
    model.quants = [...model.quants!].reverse()
    render(<DownloadOptionsSelect model={model} budgetBytes={16 * GB} />)

    const disclosure = screen.getByRole('button', { expanded: false })
    await user.click(disclosure)

    expect(screen.getByRole('button', { expanded: true })).toBeInTheDocument()
    expect(screen.getByText('Q2_K')).toBeInTheDocument()
    expect(screen.getByText('Q8_0')).toBeInTheDocument()
    // Sizes are re-derived from bytes, so they come back normalized.
    expect(screen.getByText('1.2 GB')).toBeInTheDocument()
    expect(screen.getByText('400.0 GB')).toBeInTheDocument()
    expect(
      screen
        .getAllByRole('button')
        .filter((button) => button.closest('li'))
        .map((button) => button.textContent)
    ).toEqual(['Q2_K1.2 GB', 'Q4_K_M2.5 GB', 'Q8_0400.0 GB'])
  })

  it('switches the download action to the quant the user picks', async () => {
    const user = userEvent.setup()
    render(<DownloadOptionsSelect model={ggufModel()} budgetBytes={16 * GB} />)

    await user.click(screen.getByRole('button', { expanded: false }))
    await user.click(screen.getByText('Q2_K'))

    expect(screen.getByText('download Qwen3.5-4B-Q2_K')).toBeInTheDocument()
    expect(
      screen.queryByText('download Qwen3.5-4B-Q4_K_M')
    ).not.toBeInTheDocument()
  })

  it('refuses to download a quant that cannot fit the device', async () => {
    const user = userEvent.setup()
    render(<DownloadOptionsSelect model={ggufModel()} budgetBytes={8 * GB} />)

    await user.click(screen.getByRole('button', { expanded: false }))
    await user.click(screen.getByText('Q8_0'))

    const download = screen.getByRole('button', { name: 'hub:download' })
    expect(download).toBeDisabled()
    expect(screen.getByLabelText('Too large')).toBeInTheDocument()
    await user.hover(download.parentElement!)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'This model is probably too large for your hardware'
    )
    expect(screen.queryByText(/^download /)).not.toBeInTheDocument()
  })

  it('shows only the fit dot for a comfortably small quant', () => {
    render(<DownloadOptionsSelect model={ggufModel()} budgetBytes={16 * GB} />)

    expect(screen.getByLabelText('Good fit')).toBeInTheDocument()
    expect(screen.queryByText('Good fit')).not.toBeInTheDocument()
  })

  it('shows only the fit dot for a quant that should run', () => {
    // 2.50 GB against a 3 GB budget is past the 70% comfort threshold.
    render(<DownloadOptionsSelect model={ggufModel()} budgetBytes={3 * GB} />)

    expect(screen.getByLabelText('Should run')).toBeInTheDocument()
    expect(screen.queryByText('Should run')).not.toBeInTheDocument()
  })

  it('hides the fit verdict while the memory budget is unknown', () => {
    render(<DownloadOptionsSelect model={ggufModel()} budgetBytes={0} />)

    expect(screen.queryByLabelText('Good fit')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Should run')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Too large')).not.toBeInTheDocument()
  })

  it('sends an MLX repo straight to the MLX download action', () => {
    const mlx = {
      model_name: 'mlx-community/Qwen3.5-9B-MLX-4bit',
      developer: 'mlx-community',
      is_mlx: true,
      num_quants: 0,
      quants: [],
      mmproj_models: [],
      safetensors_files: [
        { rfilename: 'model-00001-of-00002.safetensors', file_size: '3.00 GB' },
        { rfilename: 'model-00002-of-00002.safetensors', file_size: '2.00 GB' },
      ],
    } as unknown as CatalogModel

    render(<DownloadOptionsSelect model={mlx} budgetBytes={16 * GB} />)

    expect(screen.getByText('download mlx')).toBeInTheDocument()
    expect(screen.getByText('MLX')).toBeInTheDocument()
    // Sharded safetensors are summed, not reported one shard at a time.
    expect(screen.getByText('5.0 GB')).toBeInTheDocument()
    expect(screen.getByLabelText('Good fit')).toBeInTheDocument()
    expect(screen.queryByText('Good fit')).not.toBeInTheDocument()
  })
})
