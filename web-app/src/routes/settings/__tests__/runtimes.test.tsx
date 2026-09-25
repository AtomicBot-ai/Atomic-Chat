import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))

vi.mock('@/containers/runtimes/OllamaPanel', () => ({
  OllamaPanel: () => <div data-testid="ollama-panel" />,
}))

vi.mock('@/containers/SettingsMenu', () => ({
  default: () => <div data-testid="settings-menu" />,
}))
vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  }),
}))
vi.mock('@/constants/routes', () => ({
  route: { settings: { runtimes: '/settings/runtimes' } },
}))
vi.mock('@tanstack/react-router', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createFileRoute: () => (config: any) => config,
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}))

const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))

const fetchModelsFromProvider = vi.fn()
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ providers: () => ({ fetchModelsFromProvider }) }),
}))

// A minimal stand-in for the zustand provider store: a hook plus getState().
const providerStore = vi.hoisted(() => {
  const state = {
    providers: [] as ModelProvider[],
    addProvider: (provider: ModelProvider) => {
      state.providers = [...state.providers, provider]
    },
    updateProvider: (name: string, data: Partial<ModelProvider>) => {
      state.providers = state.providers.map((p) => (p.provider === name ? { ...p, ...data } : p))
    },
    getProviderByName: (name: string) => state.providers.find((p) => p.provider === name),
  }
  return state
})
vi.mock('@/hooks/useModelProvider', () => {
  const useModelProvider = () => providerStore
  useModelProvider.getState = () => providerStore
  return { useModelProvider }
})

import { Route } from '../runtimes'

const base = {
  group: 'local_desktop',
  layer: 'engine',
  wraps: [],
  capabilities: ['chat'],
  formats: ['gguf'],
  apis: ['open_ai_compatible'],
  platforms: { windows: 'native', linux: 'native', macos: 'native' },
  multi_gpu: 'layer_split',
  telemetry: [],
  granularity: 'per_request',
  license: { spdx: 'MIT', class: 'permissive' },
  maintenance: 'active',
  verified: true,
  verified_on: '2026-09-24',
  source_url: 'https://example.com',
}

const catalog = [
  { ...base, id: 'ollama', name: 'Ollama', tier: 'p0', mode: 'attach', default_port: 11434, note: 'Attach to it.' },
  { ...base, id: 'vllm', name: 'vLLM', tier: 'p2', mode: 'wsl_hosted', default_port: 8000, note: 'WSL only.' },
  {
    ...base,
    id: 'exllamav2',
    name: 'ExLlamaV2',
    tier: 'deferred',
    mode: 'managed_install',
    default_port: null,
    maintenance: 'archived',
    note: 'Archived.',
  },
]

function renderPage() {
  const Component = (Route as unknown as { component: React.ComponentType }).component
  const view = render(<Component />)
  // The catalog is folded away until asked for.
  fireEvent.click(screen.getByRole('button', { name: 'settings:runtimes.showCatalog' }))
  return view
}

describe('Settings > Runtimes', () => {
  beforeEach(() => {
    providerStore.providers = []
    toastSuccess.mockReset()
    toastError.mockReset()
    fetchModelsFromProvider.mockReset()
    invoke.mockReset()
    invoke.mockImplementation(async (command: string) => {
      if (command === 'runtimes_catalog') return catalog
      if (command === 'runtimes_detect')
        return [
          {
            baseUrl: 'http://127.0.0.1:11434',
            runtimeId: 'ollama',
            confidence: 'confirmed',
            alternatives: [],
            version: '0.12.3',
            models: ['qwen3:8b', 'llama3.2:3b'],
            loadedModels: ['qwen3:8b'],
            devices: [],
            counters: null,
          },
        ]
      throw new Error(`unexpected ${command}`)
    })
  })

  it('lists the catalog in phase order and shows maintenance warnings', async () => {
    renderPage()
    const list = await screen.findByTestId('runtime-catalog')
    await waitFor(() => expect(within(list).getAllByRole('button')).toHaveLength(3))
    const names = within(list)
      .getAllByRole('button')
      .map((row) => row.textContent)
    expect(names[0]).toContain('Ollama')
    expect(names[1]).toContain('vLLM')
    expect(names[2]).toContain('ExLlamaV2')
    expect(names[2]).toContain('settings:runtimes.maintenance.archived')
  })

  it('narrows the catalog to one phase', async () => {
    renderPage()
    const list = await screen.findByTestId('runtime-catalog')
    await waitFor(() => expect(within(list).getAllByRole('button')).toHaveLength(3))
    fireEvent.click(screen.getByText(/settings:runtimes.tier.p2 \(1\)/))
    expect(within(list).getAllByRole('button')).toHaveLength(1)
    expect(within(list).getByRole('button').textContent).toContain('vLLM')
  })

  it('opens a row to show the reason and the source', async () => {
    renderPage()
    fireEvent.click(await screen.findByText('vLLM'))
    expect(screen.getByText('WSL only.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'https://example.com' })).toBeInTheDocument()
  })

  it('scans with the added addresses and shows what answered', async () => {
    renderPage()
    await screen.findByTestId('runtime-catalog')
    fireEvent.change(screen.getByLabelText('settings:runtimes.addAddress'), {
      target: { value: 'http://192.168.1.20:8188' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'settings:runtimes.addAddress' }))
    fireEvent.click(screen.getByRole('button', { name: /settings:runtimes.scan$/ }))

    const found = await screen.findByTestId('runtime-detections')
    expect(invoke).toHaveBeenCalledWith('runtimes_detect', {
      endpoints: [{ baseUrl: 'http://192.168.1.20:8188' }],
    })
    expect(within(found).getByText('Ollama')).toBeInTheDocument()
    expect(within(found).getByText('settings:runtimes.confirmed')).toBeInTheDocument()
    expect(found.textContent).toContain('qwen3:8b')
  })

  it('says so when nothing answered, and shows a scan error as text', async () => {
    invoke.mockImplementation(async (command: string) =>
      command === 'runtimes_catalog' ? catalog : []
    )
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /settings:runtimes.scan$/ }))
    expect(await screen.findByText('settings:runtimes.noneFound')).toBeInTheDocument()

    invoke.mockImplementation(async (command: string) => {
      if (command === 'runtimes_catalog') return catalog
      throw new Error('"file:///x" must start with http:// or https://')
    })
    fireEvent.click(screen.getByRole('button', { name: /settings:runtimes.scan$/ }))
    expect(await screen.findByText(/must start with http/)).toBeInTheDocument()
  })

  it('connects a found runtime as a provider and shows it as connected', async () => {
    fetchModelsFromProvider.mockResolvedValue(['qwen3:8b', 'llama3.2:3b'])
    const { rerender } = renderPage()
    await screen.findByTestId('runtime-catalog')
    fireEvent.click(screen.getByRole('button', { name: /settings:runtimes.scan$/ }))
    const found = await screen.findByTestId('runtime-detections')

    fireEvent.click(within(found).getByRole('button', { name: /settings:runtimes.connect$/ }))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())

    const ollama = providerStore.providers.find((p) => p.provider === 'ollama')
    expect(ollama?.base_url).toBe('http://127.0.0.1:11434/v1')
    expect(ollama?.models.map((m) => m.id)).toEqual(['qwen3:8b', 'llama3.2:3b'])

    const Component = (Route as unknown as { component: React.ComponentType }).component
    rerender(<Component />)
    expect(await screen.findByText('settings:runtimes.connected')).toBeInTheDocument()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('shows the managed runtimes first and keeps the catalog folded until asked', async () => {
    const Component = (Route as unknown as { component: React.ComponentType }).component
    render(<Component />)
    expect(screen.getByTestId('ollama-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('runtime-catalog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'settings:runtimes.showCatalog' }))
    expect(await screen.findByTestId('runtime-catalog')).toBeInTheDocument()
  })
})
