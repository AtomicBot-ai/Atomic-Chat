import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useModelProvider } from '@/hooks/useModelProvider'
import type { AppService } from '@/services/app/types'
import type { DialogService } from '@/services/dialog/types'
import type { ModelsService } from '@/services/models/types'
import type { ProvidersService } from '@/services/providers/types'
import { seedServiceHub } from '@/test/service-hub'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const toastSuccess = vi.fn()
const toastWarning = vi.fn()
const toastError = vi.fn()
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    warning: (...args: unknown[]) => toastWarning(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))

vi.mock('@/containers/LocalModelLocationsCard', () => ({
  default: () => <div>Detected model locations</div>,
}))

import { ModelsFolderDialog } from '../ModelsFolderDialog'

const DEFAULT = 'C:\\Users\\me\\AppData\\Roaming\\Radium\\data\\llamacpp\\models'

const getModelsFolder = vi.fn()
const setModelsFolder = vi.fn()
const openDialog = vi.fn()
const stopAllModels = vi.fn()
const getProviders = vi.fn()
const setProviders = vi.fn()

const openPanel = async () => {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'hub:modelsFolder.button' }))
  await waitFor(() =>
    expect(screen.getByTestId('models-folder-path')).not.toHaveTextContent('…')
  )
  return user
}

describe('ModelsFolderDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    globalThis.IS_TAURI = true
    getModelsFolder.mockResolvedValue({
      path: DEFAULT,
      default_path: DEFAULT,
      is_default: true,
    })
    setModelsFolder.mockResolvedValue({ moved: ['org', 'qwen'], skipped: [], failed: [] })
    openDialog.mockResolvedValue('D:\\Models')
    stopAllModels.mockResolvedValue(undefined)
    getProviders.mockResolvedValue([{ provider: 'llamacpp', models: [] }])
    seedServiceHub({
      app: { getModelsFolder, setModelsFolder } as unknown as AppService,
      dialog: { open: openDialog } as unknown as DialogService,
      models: { stopAllModels } as unknown as ModelsService,
      providers: { getProviders } as unknown as ProvidersService,
    })
    useModelProvider.setState({ providers: [], setProviders })
  })

  it('shows where models are saved now', async () => {
    render(<ModelsFolderDialog />)
    await openPanel()

    expect(screen.getByTestId('models-folder-path')).toHaveTextContent(DEFAULT)
    expect(screen.getByText('hub:modelsFolder.default')).toBeInTheDocument()
    expect(screen.getByText('Detected model locations')).toBeInTheDocument()
    // Nothing to apply until a folder is chosen.
    expect(screen.getByRole('button', { name: 'hub:modelsFolder.apply' })).toBeDisabled()
  })

  it('moves the existing models into a chosen folder and refreshes the list', async () => {
    render(<ModelsFolderDialog />)
    const user = await openPanel()

    await user.click(screen.getByRole('button', { name: 'hub:modelsFolder.choose' }))
    await waitFor(() =>
      expect(screen.getByTestId('models-folder-path')).toHaveTextContent('D:\\Models')
    )
    expect(openDialog).toHaveBeenCalledWith(
      expect.objectContaining({ directory: true, defaultPath: DEFAULT })
    )
    expect(screen.getByRole('switch', { name: 'hub:modelsFolder.moveExisting' })).toBeChecked()

    await user.click(screen.getByRole('button', { name: 'hub:modelsFolder.apply' }))

    await waitFor(() => expect(setModelsFolder).toHaveBeenCalledWith('D:\\Models', true))
    // Loaded models are stopped before their files move.
    expect(stopAllModels.mock.invocationCallOrder[0]).toBeLessThan(
      setModelsFolder.mock.invocationCallOrder[0]
    )
    // The model list is fetched again, so it shows what is in the new folder.
    await waitFor(() =>
      expect(setProviders).toHaveBeenCalledWith([
        { provider: 'llamacpp', models: [] },
      ])
    )
    expect(toastSuccess).toHaveBeenCalledWith('hub:modelsFolder.movedCount')
  })

  it('can leave the existing models where they are', async () => {
    setModelsFolder.mockResolvedValue({ moved: [], skipped: [], failed: [] })
    render(<ModelsFolderDialog />)
    const user = await openPanel()

    await user.click(screen.getByRole('button', { name: 'hub:modelsFolder.choose' }))
    const moveSwitch = await screen.findByRole('switch', {
      name: 'hub:modelsFolder.moveExisting',
    })
    await user.click(moveSwitch)
    expect(screen.getByText('hub:modelsFolder.leaveExistingHint')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'hub:modelsFolder.apply' }))

    await waitFor(() => expect(setModelsFolder).toHaveBeenCalledWith('D:\\Models', false))
    expect(toastSuccess).toHaveBeenCalledWith('hub:modelsFolder.changed')
  })

  it('goes back to the default folder', async () => {
    getModelsFolder.mockResolvedValue({
      path: 'D:\\Models',
      default_path: DEFAULT,
      is_default: false,
    })
    render(<ModelsFolderDialog />)
    const user = await openPanel()

    await user.click(screen.getByRole('button', { name: 'hub:modelsFolder.useDefault' }))
    expect(screen.getByTestId('models-folder-path')).toHaveTextContent(DEFAULT)
    await user.click(screen.getByRole('button', { name: 'hub:modelsFolder.apply' }))

    await waitFor(() => expect(setModelsFolder).toHaveBeenCalledWith(null, true))
  })

  it('says which models could not be moved', async () => {
    setModelsFolder.mockResolvedValue({
      moved: ['org'],
      skipped: [],
      failed: [['qwen', 'file is in use']],
    })
    render(<ModelsFolderDialog />)
    const user = await openPanel()

    await user.click(screen.getByRole('button', { name: 'hub:modelsFolder.choose' }))
    await user.click(await screen.findByRole('button', { name: 'hub:modelsFolder.apply' }))

    await waitFor(() =>
      expect(toastWarning).toHaveBeenCalledWith('hub:modelsFolder.someNotMoved', {
        description: 'qwen: file is in use',
      })
    )
    // The folder did change, so the panel closes like any other success.
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'hub:modelsFolder.apply' })
      ).not.toBeInTheDocument()
    )
  })

  it('keeps the panel open and shows the reason when the change is refused', async () => {
    setModelsFolder.mockRejectedValue(new Error('A download is still running.'))
    render(<ModelsFolderDialog />)
    const user = await openPanel()

    await user.click(screen.getByRole('button', { name: 'hub:modelsFolder.choose' }))
    await user.click(await screen.findByRole('button', { name: 'hub:modelsFolder.apply' }))

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('hub:modelsFolder.failed', {
        description: 'A download is still running.',
      })
    )
    expect(screen.getByRole('button', { name: 'hub:modelsFolder.apply' })).toBeEnabled()
  })
})
