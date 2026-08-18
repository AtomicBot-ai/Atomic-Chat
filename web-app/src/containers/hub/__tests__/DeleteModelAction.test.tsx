import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppState } from '@/hooks/useAppState'
import { useFavoriteModel } from '@/hooks/useFavoriteModel'
import { useModelProvider } from '@/hooks/useModelProvider'
import type { ModelsService } from '@/services/models/types'
import type { ProvidersService } from '@/services/providers/types'
import { seedServiceHub } from '@/test/service-hub'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))

import { DeleteModelAction } from '../DeleteModelAction'

const deleteModel = vi.fn()
const stopModel = vi.fn()
const getProviders = vi.fn()

const llamacpp = (ids: string[]): ModelProvider =>
  ({
    active: true,
    provider: 'llamacpp',
    persist: true,
    settings: [],
    models: ids.map((id) => ({ id })),
  }) as ModelProvider

const openConfirm = async () => {
  const user = userEvent.setup()
  await user.click(
    screen.getByRole('button', { name: 'common:deleteModel.delete' })
  )
  const confirm = await screen.findAllByRole('button', {
    name: 'common:deleteModel.delete',
  })
  return { user, confirm: confirm[confirm.length - 1] }
}

describe('DeleteModelAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    deleteModel.mockResolvedValue(undefined)
    stopModel.mockResolvedValue(undefined)
    getProviders.mockResolvedValue([llamacpp([])])
    seedServiceHub({
      models: { deleteModel, stopModel } as unknown as ModelsService,
      providers: { getProviders } as unknown as ProvidersService,
    })
    useModelProvider.setState({
      providers: [llamacpp(['Qwen3-4B-Q4_K_M'])],
      deletedModels: [],
    })
    useFavoriteModel.setState({
      favoriteModels: [{ id: 'Qwen3-4B-Q4_K_M' } as Model],
    })
    useAppState.setState({ activeModels: [] })
  })

  it('only deletes after the confirmation is accepted', async () => {
    render(<DeleteModelAction modelId="Qwen3-4B-Q4_K_M" provider="llamacpp" />)

    expect(deleteModel).not.toHaveBeenCalled()

    const { user, confirm } = await openConfirm()
    await user.click(confirm)

    await waitFor(() =>
      expect(deleteModel).toHaveBeenCalledWith('Qwen3-4B-Q4_K_M', 'llamacpp')
    )
  })

  it('drops the model from the provider list and from favorites', async () => {
    const onDeleted = vi.fn()
    render(
      <DeleteModelAction
        modelId="Qwen3-4B-Q4_K_M"
        provider="llamacpp"
        onDeleted={onDeleted}
      />
    )

    const { user, confirm } = await openConfirm()
    await user.click(confirm)

    await waitFor(() => expect(onDeleted).toHaveBeenCalled())
    await waitFor(() =>
      expect(
        useModelProvider
          .getState()
          .providers.flatMap((provider) => provider.models)
      ).toHaveLength(0)
    )
    expect(useFavoriteModel.getState().favoriteModels).toHaveLength(0)
    expect(toastSuccess).toHaveBeenCalled()
  })

  it('unloads a running model before removing its files', async () => {
    useAppState.setState({ activeModels: ['Qwen3-4B-Q4_K_M'] })
    render(<DeleteModelAction modelId="Qwen3-4B-Q4_K_M" provider="llamacpp" />)

    const { user, confirm } = await openConfirm()
    await user.click(confirm)

    await waitFor(() =>
      expect(stopModel).toHaveBeenCalledWith('Qwen3-4B-Q4_K_M', 'llamacpp')
    )
    expect(deleteModel).toHaveBeenCalled()
    await waitFor(() => expect(useAppState.getState().activeModels).toEqual([]))
  })

  it('keeps the model listed and reports the failure when the engine refuses', async () => {
    deleteModel.mockRejectedValue(new Error('Model does not exist'))
    render(<DeleteModelAction modelId="Qwen3-4B-Q4_K_M" provider="llamacpp" />)

    const { user, confirm } = await openConfirm()
    await user.click(confirm)

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(getProviders).not.toHaveBeenCalled()
    expect(
      useModelProvider.getState().providers[0].models.map((m) => m.id)
    ).toEqual(['Qwen3-4B-Q4_K_M'])
  })
})
