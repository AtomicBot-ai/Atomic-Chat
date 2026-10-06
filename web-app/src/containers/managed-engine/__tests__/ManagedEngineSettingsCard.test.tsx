import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  }),
}))

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { ManagedEngineSettingsCard } from '../ManagedEngineSettingsCard'
import { TENSORRT_LLM_ENGINE } from '@/lib/managed-engines'
import { useManagedEnvironmentStore } from '@/stores/managed-environment-store'

const gpu = (gpu_id: string, name: string, free: number) => ({
  gpu_id,
  name,
  compute_capability: '8.9',
  total_vram_bytes: 24 * 1024 ** 3,
  free_vram_bytes: free * 1024 ** 3,
  driver_version: '590',
})

beforeEach(() => {
  invoke.mockReset()
  useManagedEnvironmentStore.getState().reset()
  useManagedEnvironmentStore.getState().applySnapshot({
    instance_id: 'core-a',
    environments: [
      {
        schema_version: 1,
        environment_id: 'default',
        instance_id: 'core-a',
        revision: 1,
        executor: 'linux-docker',
        availability: 'supported',
        gpus: [gpu('GPU-aaa', 'RTX 4090', 19), gpu('GPU-bbb', 'RTX 4090', 23)],
        blockers: [],
        selinux: false,
        installations: [],
        active_operation_id: null,
        minimum_app_version: null,
      },
    ],
    environment_operations: [],
  })
})

const settings = (values: Record<string, unknown>) =>
  Object.entries(values).map(([key, value]) => ({
    key,
    title: key,
    description: '',
    controller_type: 'input',
    controller_props: { value },
  })) as unknown as ProviderSetting[]

describe('ManagedEngineSettingsCard', () => {
  it('offers the cards the core found, by name, with the most-free-memory default first', async () => {
    // Through the app's own menu, never a native <select> (task 3.19, F-11: dark theme).
    const onChange = vi.fn()
    const user = userEvent.setup()
    const { container } = render(
      <ManagedEngineSettingsCard
        engine={TENSORRT_LLM_ENGINE}
        settings={settings({ gpu_id: '', context_length: 8192, max_output_tokens: 4096 })}
        models={[]}
        onChange={onChange}
      />
    )

    expect(container.querySelector('select')).toBeNull()
    const trigger = screen.getByRole('button', { name: 'providers:tensorrt.settings.gpuDefault' })
    await user.click(trigger)
    const items = screen.getAllByRole('menuitem').map((item) => item.textContent)
    expect(items).toEqual([
      'providers:tensorrt.settings.gpuDefault',
      'RTX 4090 (8.9) · 19.0 GB / 24.0 GB',
      'RTX 4090 (8.9) · 23.0 GB / 24.0 GB',
    ])
    await user.click(screen.getByRole('menuitem', { name: 'RTX 4090 (8.9) · 23.0 GB / 24.0 GB' }))
    expect(onChange.mock.calls).toEqual([['gpu_id', 'GPU-bbb']])
  })

  it('goes back to the default card from a chosen one', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <ManagedEngineSettingsCard
        engine={TENSORRT_LLM_ENGINE}
        settings={settings({ gpu_id: 'GPU-aaa', context_length: 8192, max_output_tokens: 4096 })}
        models={[]}
        onChange={onChange}
      />
    )

    await user.click(screen.getByRole('button', { name: 'RTX 4090 (8.9) · 19.0 GB / 24.0 GB' }))
    await user.click(screen.getByRole('menuitem', { name: 'providers:tensorrt.settings.gpuDefault' }))
    expect(onChange.mock.calls).toEqual([['gpu_id', '']])
  })

  it('keeps a saved card that is gone visible, so the person sees what the load will replace', async () => {
    const user = userEvent.setup()
    render(
      <ManagedEngineSettingsCard
        engine={TENSORRT_LLM_ENGINE}
        settings={settings({ gpu_id: 'GPU-gone', context_length: 8192, max_output_tokens: 4096 })}
        models={[]}
        onChange={vi.fn()}
      />
    )

    await user.click(screen.getByRole('button', { name: 'GPU-gone' }))
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toContain('GPU-gone')
    expect(screen.getByText(/providers:tensorrt.settings.gpuMissing/)).toBeInTheDocument()
  })

  it('warns when the output limit does not fit inside the context', () => {
    render(
      <ManagedEngineSettingsCard
        engine={TENSORRT_LLM_ENGINE}
        settings={settings({ gpu_id: '', context_length: 4096, max_output_tokens: 4096 })}
        models={[]}
        onChange={vi.fn()}
      />
    )

    expect(screen.getByText(/providers:tensorrt.settings.outputTooLong/)).toBeInTheDocument()
  })

  it('shows the log of a model: its session, or the last failed attempt with the reason', async () => {
    invoke.mockResolvedValueOnce({
      model_id: 'nvidia/Qwen3-8B-FP8',
      source: 'last-attempt',
      generation: 'g-2',
      log_tail: 'CUDA out of memory. Tried to allocate 2.00 GiB',
      error: { code: 'MODEL_LOAD_FAILED', message: 'The GPU ran out of memory while loading.' },
      at: 1,
    })
    render(
      <ManagedEngineSettingsCard
        engine={TENSORRT_LLM_ENGINE}
        settings={settings({ gpu_id: '', context_length: 8192, max_output_tokens: 4096 })}
        models={['nvidia/Qwen3-8B-FP8']}
        onChange={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'providers:tensorrt.settings.viewLogs' }))

    expect(await screen.findByText(/CUDA out of memory/)).toBeInTheDocument()
    expect(screen.getByText('The GPU ran out of memory while loading.')).toBeInTheDocument()
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('atomic_core_call', {
        method: 'GET',
        path: '/models/tensorrt-llm/nvidia/Qwen3-8B-FP8/logs',
        body: null,
      })
    )
  })
})

describe('ManagedEngineSettingsCard: one entry point for the logs', () => {
  it('offers one "view logs" button and a model menu, not a button per model, and names whose log it shows', async () => {
    invoke.mockResolvedValue({ model_id: 'b/two', source: null, log_tail: '' })
    const user = userEvent.setup()
    render(
      <ManagedEngineSettingsCard
        engine={TENSORRT_LLM_ENGINE}
        settings={settings({ gpu_id: '', context_length: 8192, max_output_tokens: 4096 })}
        models={['a/one', 'b/two', 'c/three']}
        onChange={vi.fn()}
      />
    )

    expect(screen.getAllByRole('button', { name: 'providers:tensorrt.settings.viewLogs' })).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'a/one' }))
    await user.click(screen.getByRole('menuitem', { name: 'b/two' }))
    await user.click(screen.getByRole('button', { name: 'providers:tensorrt.settings.viewLogs' }))

    expect(await screen.findByText('providers:tensorrt.settings.noLogs')).toBeInTheDocument()
    expect(screen.getByText(/providers:tensorrt.settings.logOf .*b\/two/)).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith('atomic_core_call', {
      method: 'GET',
      path: '/models/tensorrt-llm/b/two/logs',
      body: null,
    })
  })

  it('has no logs row before any model is downloaded', () => {
    render(
      <ManagedEngineSettingsCard
        engine={TENSORRT_LLM_ENGINE}
        settings={settings({ gpu_id: '', context_length: 8192, max_output_tokens: 4096 })}
        models={[]}
        onChange={vi.fn()}
      />
    )
    expect(screen.queryByRole('button', { name: 'providers:tensorrt.settings.viewLogs' })).toBeNull()
  })
})
