import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  getProviders: vi.fn(async () => [] as ModelProvider[]),
  toastError: vi.fn(),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({
    dialog: () => ({ open: mocks.open }),
    providers: () => ({ getProviders: mocks.getProviders }),
  }),
}))

type DialogProps = {
  provider: ModelProvider
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onSuccess?: () => void
}

// The import dialogs are the engine pages' own; here they only say what they
// were opened with.
vi.mock('@/containers/dialogs/ImportVisionModelDialog', () => ({
  ImportVisionModelDialog: ({
    provider,
    open,
    initialModelFile,
    onOpenChange,
    onSuccess,
  }: DialogProps & { initialModelFile?: string }) =>
    open ? (
      <div
        role="dialog"
        aria-label="gguf import"
        data-provider={provider.provider}
      >
        {initialModelFile}
        <button type="button" onClick={onSuccess}>
          imported
        </button>
        <button type="button" onClick={() => onOpenChange?.(false)}>
          cancel
        </button>
      </div>
    ) : null,
}))
vi.mock('@/containers/dialogs/ImportMlxModelDialog', () => ({
  ImportMlxModelDialog: ({
    open,
    initialPath,
  }: DialogProps & { initialPath?: string }) =>
    open ? (
      <div role="dialog" aria-label="mlx import">
        {initialPath}
      </div>
    ) : null,
}))

import { ImportLocalFile } from '../ImportLocalFile'
import { useModelProvider } from '@/hooks/useModelProvider'

const withProviders = (...ids: string[]) =>
  useModelProvider.setState({
    providers: ids.map(
      (provider) => ({ provider, models: [], settings: [] }) as never
    ),
  })

describe('ImportLocalFile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    withProviders('llamacpp-upstream', 'mlx')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows nothing without a local engine to import into', () => {
    withProviders('openai')
    const { container } = render(<ImportLocalFile />)
    expect(container).toBeEmptyDOMElement()
  })

  it('hands a GGUF file to the llama.cpp import, already chosen', async () => {
    const user = userEvent.setup()
    mocks.open.mockResolvedValue('/models/Qwen3-8B-Q4_K_M.GGUF')
    render(<ImportLocalFile />)

    await user.click(screen.getByRole('button', { name: /hub:import.button/ }))

    expect(mocks.open).toHaveBeenCalledWith({
      multiple: false,
      directory: false,
    })
    const dialog = await screen.findByRole('dialog', { name: 'gguf import' })
    expect(dialog).toHaveTextContent('/models/Qwen3-8B-Q4_K_M.GGUF')
    expect(dialog).toHaveAttribute('data-provider', 'llamacpp-upstream')
    expect(mocks.toastError).not.toHaveBeenCalled()

    // The Hub lists the model once it is imported.
    await user.click(screen.getByText('imported'))
    expect(mocks.getProviders).toHaveBeenCalled()
    await user.click(screen.getByText('cancel'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('refuses any other file and says what can be imported', async () => {
    const user = userEvent.setup()
    mocks.open.mockResolvedValue('/models/model.safetensors')
    render(<ImportLocalFile />)

    await user.click(screen.getByRole('button', { name: /hub:import.button/ }))

    expect(mocks.toastError).toHaveBeenCalledWith(
      'hub:import.unsupportedTitle',
      expect.objectContaining({ description: 'hub:import.unsupportedGguf' })
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('does nothing when the picker is dismissed', async () => {
    const user = userEvent.setup()
    mocks.open.mockResolvedValue(null)
    render(<ImportLocalFile />)

    await user.click(screen.getByRole('button', { name: /hub:import.button/ }))

    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('offers an MLX model folder on a Mac, for the MLX import', async () => {
    vi.stubGlobal('IS_MACOS', true)
    const user = userEvent.setup()
    mocks.open.mockResolvedValue('/models/Qwen3-8B-4bit')
    render(<ImportLocalFile />)

    await user.click(screen.getByRole('button', { name: /hub:import.button/ }))
    expect(
      screen.getByRole('menuitem', { name: 'hub:import.ggufFile' })
    ).toBeInTheDocument()
    await user.click(
      screen.getByRole('menuitem', { name: 'hub:import.mlxFolder' })
    )

    expect(mocks.open).toHaveBeenCalledWith({
      multiple: false,
      directory: true,
    })
    expect(
      await screen.findByRole('dialog', { name: 'mlx import' })
    ).toHaveTextContent('/models/Qwen3-8B-4bit')
  })

  it('names both imports when a Mac refuses a file', async () => {
    vi.stubGlobal('IS_MACOS', true)
    const user = userEvent.setup()
    mocks.open.mockResolvedValue('/models/model.bin')
    render(<ImportLocalFile />)

    await user.click(screen.getByRole('button', { name: /hub:import.button/ }))
    await user.click(
      screen.getByRole('menuitem', { name: 'hub:import.ggufFile' })
    )

    expect(mocks.toastError).toHaveBeenCalledWith(
      'hub:import.unsupportedTitle',
      expect.objectContaining({
        description: 'hub:import.unsupportedGgufOrMlx',
      })
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
