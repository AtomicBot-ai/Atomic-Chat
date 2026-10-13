import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import type { OllamaSettings, OllamaStatus } from '@/services/ollama'

const api = vi.hoisted(() => ({
  status: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  restart: vi.fn(),
  takeOver: vi.fn(),
  saveSettings: vi.fn(),
  logs: vi.fn(),
  models: vi.fn(),
  deleteModel: vi.fn(),
  loadModel: vi.fn(),
  unloadModel: vi.fn(),
  install: vi.fn(),
  cancelInstall: vi.fn(),
  pull: vi.fn(),
  cancelPull: vi.fn(),
}))
vi.mock('@/services/ollama', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/ollama')>()),
  ollama: api,
}))

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const connectRuntime = vi.hoisted(() => vi.fn())
vi.mock('@/lib/connect-runtime', () => ({ connectRuntime }))

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({
    hardware: () => ({
      getHardwareInfo: async () => ({
        gpus: [
          { uuid: 'aaa', name: 'NVIDIA GeForce RTX 3090', vendor: 'NVIDIA' },
          { uuid: 'bbb', name: 'NVIDIA GeForce RTX 3090', vendor: 'NVIDIA' },
        ],
      }),
    }),
    providers: () => ({ fetchModelsFromProvider: vi.fn() }),
  }),
}))

vi.mock('@/hooks/useModelProvider', () => {
  const state = {
    providers: [],
    addProvider: vi.fn(),
    updateProvider: vi.fn(),
    getProviderByName: vi.fn(),
  }
  const useModelProvider = () => state
  useModelProvider.getState = () => state
  return { useModelProvider }
})

import { OllamaPanel } from '../OllamaPanel'

const settings: OllamaSettings = {
  port: 11434,
  allowNetwork: false,
  modelsDir: '',
  contextLength: 0,
  keepAlive: '5m',
  flashAttention: false,
  kvCacheType: 'f16',
  numParallel: 0,
  maxLoadedModels: 0,
  gpus: '',
  spreadAcrossGpus: false,
  gpuOverheadMib: 0,
  noCloud: false,
  autoStart: false,
  extraEnv: '',
}

function status(partial: Partial<OllamaStatus>): OllamaStatus {
  return {
    running: false,
    pid: null,
    baseUrl: 'http://127.0.0.1:11434',
    startedAtMs: null,
    version: null,
    binary: { path: 'C:/Ollama/ollama.exe', source: 'radium' },
    canInstall: true,
    installVersion: '0.34.4',
    installBytes: 1_460_000_000,
    settings,
    defaultModelsDir: 'C:\\Users\\Warwick\\.ollama\\models',
    external: null,
    ...partial,
  }
}

const running = status({ running: true, pid: 4242, version: '0.34.4' })

const models = {
  installed: [
    {
      name: 'qwen3:8b',
      sizeBytes: 5_200_000_000,
      modifiedAt: null,
      family: 'qwen3',
      parameterSize: '8.2B',
      quantization: 'Q4_K_M',
    },
    {
      name: 'gemma3:27b',
      sizeBytes: 17_000_000_000,
      modifiedAt: null,
      family: 'gemma3',
      parameterSize: '27B',
      quantization: 'Q4_K_M',
    },
  ],
  loaded: [{ name: 'qwen3:8b', sizeBytes: 6_000_000_000, vramBytes: 6_000_000_000, expiresAt: null }],
}

describe('OllamaPanel', () => {
  beforeEach(() => {
    Object.values(api).forEach((fn) => fn.mockReset())
    toast.success.mockReset()
    toast.error.mockReset()
    connectRuntime.mockReset()
    connectRuntime.mockResolvedValue({ providerId: 'ollama', modelCount: 2, usedScanModels: false })
    api.logs.mockResolvedValue([])
    api.models.mockResolvedValue(models)
  })

  it('offers to install when Ollama is missing, then starts it and connects it', async () => {
    api.status.mockResolvedValue(status({ binary: null }))
    api.install.mockImplementation(async (_id: string, onProgress: (r: number, t: number) => void) => {
      onProgress(730_000_000, 1_460_000_000)
      return { path: 'C:/ollama.exe', source: 'radium' }
    })
    api.start.mockResolvedValue(running)
    render(<OllamaPanel />)
    expect(await screen.findByText('Not installed')).toBeInTheDocument()
    expect(screen.getByText(/Radium can install Ollama 0.34.4 \(1.4 GB\)/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Install/ }))
    await waitFor(() => expect(api.start).toHaveBeenCalled())
    expect(connectRuntime).toHaveBeenCalledWith(
      { kind: 'provider', providerId: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
      [],
      expect.anything()
    )
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('lists models with what is in memory, and loads, unloads and deletes them', async () => {
    api.status.mockResolvedValue(running)
    api.loadModel.mockResolvedValue(undefined)
    api.unloadModel.mockResolvedValue(undefined)
    api.deleteModel.mockResolvedValue(undefined)
    render(<OllamaPanel />)
    const list = await screen.findByTestId('ollama-models')
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('in memory')
    expect(screen.getByText('2 installed · 1 in memory')).toBeInTheDocument()

    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Unload' }))
    await waitFor(() =>
      expect(api.unloadModel).toHaveBeenCalledWith('http://127.0.0.1:11434', 'qwen3:8b')
    )
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Load' }))
    await waitFor(() =>
      expect(api.loadModel).toHaveBeenCalledWith('http://127.0.0.1:11434', 'gemma3:27b')
    )

    // Delete asks once more, showing what it frees.
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Delete gemma3:27b' }))
    expect(api.deleteModel).not.toHaveBeenCalled()
    fireEvent.click(within(rows[1]).getByRole('button', { name: /Delete 16 GB\?/ }))
    await waitFor(() =>
      expect(api.deleteModel).toHaveBeenCalledWith('http://127.0.0.1:11434', 'gemma3:27b')
    )
  })

  it('downloads a model with live progress', async () => {
    api.status.mockResolvedValue(running)
    let release: () => void = () => undefined
    api.pull.mockImplementation(
      (_url: string, _model: string, _id: string, onProgress: (p: unknown) => void) =>
        new Promise<void>((resolve) => {
          onProgress({ status: 'pulling 1a2b3c4d5e6f7a8b', completed: 500, total: 2000, done: false })
          release = resolve
        })
    )
    render(<OllamaPanel />)
    await screen.findByTestId('ollama-models')
    fireEvent.change(screen.getByLabelText('Model to download'), { target: { value: 'llama3.2:3b' } })
    fireEvent.click(screen.getByRole('button', { name: /^Download$/ }))
    const progress = await screen.findByTestId('ollama-pull')
    expect(progress.textContent).toContain('llama3.2:3b')
    expect(progress.textContent).toContain('downloading 1a2b3c4d5e6f')
    release()
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('llama3.2:3b downloaded'))
  })

  it('saves settings and restarts only when a running Ollama needs it', async () => {
    let current = running
    api.status.mockImplementation(async () => current)
    api.saveSettings.mockImplementation(async (next: OllamaSettings) => {
      const needsRestart = next.contextLength !== current.settings.contextLength
      current = { ...current, settings: next }
      return { settings: next, needsRestart }
    })
    api.restart.mockImplementation(async () => current)
    render(<OllamaPanel />)
    await screen.findByTestId('ollama-models')

    const contextRow = document.querySelector<HTMLElement>('[data-setting="contextLength"]')!
    fireEvent.change(within(contextRow).getByRole('textbox'), { target: { value: '32768' } })
    expect(await screen.findByText('1 unsaved')).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'Save and restart' }))

    await waitFor(() => expect(screen.queryByText('1 unsaved')).toBeNull())
    expect(api.saveSettings.mock.calls[0][0].contextLength).toBe(32768)
    expect(api.restart).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('offers to run an Ollama started elsewhere in Radium, after asking', async () => {
    api.status.mockResolvedValue(
      status({
        external: {
          baseUrl: 'http://127.0.0.1:11434',
          version: '0.30.0',
          processes: [
            { pid: 10, name: 'ollama app.exe', exe: null },
            { pid: 11, name: 'ollama.exe', exe: 'C:/Ollama/ollama.exe' },
          ],
        },
      })
    )
    api.takeOver.mockResolvedValue(running)
    render(<OllamaPanel />)
    expect(await screen.findByText('Running outside Radium')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Run it in Radium' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('including its tray app')
    expect(dialog.textContent).toContain('ollama.exe (pid 11)')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run it in Radium' }))
    await waitFor(() => expect(api.takeOver).toHaveBeenCalled())
    expect(connectRuntime).toHaveBeenCalled()
  })

  it('shows why a start failed', async () => {
    api.status.mockResolvedValue(status({}))
    api.start.mockRejectedValue(new Error('Port 11434 is in use by another program'))
    render(<OllamaPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Ollama: start failed', {
        description: 'Port 11434 is in use by another program',
      })
    )
    // Still stopped, and Start can be tried again.
    expect(screen.getByTestId('ollama-phase').textContent).toBe('Stopped')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled())
  })
})
