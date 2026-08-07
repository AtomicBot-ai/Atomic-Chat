import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { CatalogModel } from '@/services/models/types'

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

describe('DownloadOptionsSelect', () => {
  it('preselects the default quantization rather than the first one', () => {
    render(<DownloadOptionsSelect model={ggufModel()} budgetBytes={16 * GB} />)

    expect(screen.getByText('Q4_K_M')).toBeInTheDocument()
    expect(screen.getByText('download Qwen3.5-4B-Q4_K_M')).toBeInTheDocument()
  })

  it('lists every quant with its size once expanded', async () => {
    const user = userEvent.setup()
    render(<DownloadOptionsSelect model={ggufModel()} budgetBytes={16 * GB} />)

    const disclosure = screen.getByRole('button', { expanded: false })
    await user.click(disclosure)

    expect(screen.getByRole('button', { expanded: true })).toBeInTheDocument()
    expect(screen.getByText('Q2_K')).toBeInTheDocument()
    expect(screen.getByText('Q8_0')).toBeInTheDocument()
    // Sizes are re-derived from bytes, so they come back normalized.
    expect(screen.getByText('1.2 GB')).toBeInTheDocument()
    expect(screen.getByText('400.0 GB')).toBeInTheDocument()
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

    expect(screen.getByRole('button', { name: 'hub:download' })).toBeDisabled()
    expect(screen.getByText('hub:likelyTooLarge')).toBeInTheDocument()
    expect(screen.queryByText(/^download /)).not.toBeInTheDocument()
  })

  it('promises a full GPU offload for a quant that fits', () => {
    render(<DownloadOptionsSelect model={ggufModel()} budgetBytes={16 * GB} />)

    expect(screen.getByText('hub:fullGpuOffload')).toBeInTheDocument()
  })

  it('hides the fit verdict while the memory budget is unknown', () => {
    render(<DownloadOptionsSelect model={ggufModel()} budgetBytes={0} />)

    expect(screen.queryByText('hub:fullGpuOffload')).not.toBeInTheDocument()
    expect(screen.queryByText('hub:likelyTooLarge')).not.toBeInTheDocument()
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
    expect(screen.getByText('hub:fullGpuOffload')).toBeInTheDocument()
  })
})
