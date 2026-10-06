import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  }),
}))

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const deletion = vi.hoisted(() => ({ deleteLocalModel: vi.fn() }))
vi.mock('@/lib/model-deletion', () => deletion)

vi.mock('@/hooks/useServiceHub', () => ({ useServiceHub: () => ({}) }))

import { DialogDeleteModel } from '../DeleteModel'

const trt = {
  provider: 'tensorrt-llm',
  active: true,
  settings: [],
  models: [{ id: 'Qwen/Qwen3-1.7B', model: 'Qwen/Qwen3-1.7B' }],
} as unknown as ModelProvider

async function confirmDelete() {
  render(<DialogDeleteModel provider={trt} modelId="Qwen/Qwen3-1.7B" />)
  fireEvent.click(screen.getByLabelText('providers:deleteModel.delete'))
  fireEvent.click(await screen.findByRole('button', { name: 'providers:deleteModel.delete' }))
}

describe('DialogDeleteModel', () => {
  beforeEach(() => vi.clearAllMocks())

  it('says how much space the delete freed when the engine measured it (task 3.15)', async () => {
    deletion.deleteLocalModel.mockResolvedValue({ freedBytes: 4 * 1024 ** 3 })
    await confirmDelete()

    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1))
    const [, options] = toast.success.mock.calls[0] as [string, { description: string }]
    expect(options.description).toBe(
      'providers:deleteModel.successFreed {"modelId":"Qwen/Qwen3-1.7B","size":"4.0 GB"}'
    )
  })

  it("shows the engine's reason when the delete is refused", async () => {
    deletion.deleteLocalModel.mockRejectedValue(
      new Error('TensorRT-LLM could not stop Qwen/Qwen3-1.7B, so its files were not touched.')
    )
    await confirmDelete()

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
    const [, options] = toast.error.mock.calls[0] as [string, { description: string }]
    expect(options.description).toBe(
      'TensorRT-LLM could not stop Qwen/Qwen3-1.7B, so its files were not touched.'
    )
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('warns that a model of the shared store goes from every managed engine (spec vllm-desktop)', async () => {
    render(<DialogDeleteModel provider={trt} modelId="Qwen/Qwen3-1.7B" />)
    fireEvent.click(screen.getByLabelText('providers:deleteModel.delete'))

    expect(
      await screen.findByText('providers:deleteModel.managedShared {"engines":"vLLM, TensorRT-LLM"}')
    ).toBeInTheDocument()
  })

  it('says nothing about other engines for a provider with its own models', async () => {
    const llama = { ...trt, provider: 'llamacpp' } as unknown as ModelProvider
    render(<DialogDeleteModel provider={llama} modelId="Qwen/Qwen3-1.7B" />)
    fireEvent.click(screen.getByLabelText('providers:deleteModel.delete'))

    await screen.findByRole('button', { name: 'providers:deleteModel.delete' })
    expect(screen.queryByText(/providers:deleteModel.managedShared/)).not.toBeInTheDocument()
  })
})
