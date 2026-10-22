import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Keys and their parameters are what the block decides; the English copy lives in the locale file.
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  }),
}))

const core = vi.hoisted(() => ({
  liteRtLmAccelerators: vi.fn(),
  prepareLiteRtLmAccelerators: vi.fn(),
}))
vi.mock('@/services/litert-lm/core', () => core)

const events = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    events.handlers.set(name, handler)
    return () => events.handlers.delete(name)
  }),
}))

import { LiteRtLmAccelerators } from '../LiteRtLmAccelerators'
import { useLiteRtLmInstallStore } from '../install-store'
import type { LiteRtLmAccelerator, LiteRtLmAccelerators as Answer } from '@/services/litert-lm/types'

const PREPARE_EVENT = 'atomic-core://litert-lm:accelerators'

function answer(accelerators: LiteRtLmAccelerator[], extra: Partial<Answer> = {}): Answer {
  return {
    installed: true,
    build: '0.18.1/win-x64',
    npu: accelerators.length > 0 ? 'intel-lnl' : null,
    accelerators,
    error: null,
    ...extra,
  }
}

const openvino = (extra: Partial<LiteRtLmAccelerator> = {}): LiteRtLmAccelerator => ({
  name: 'openvino',
  device: 'npu',
  version: '2026.4.1',
  size_bytes: 85 * 1024 ** 2,
  prepared: false,
  ...extra,
})

const emit = (payload: unknown) =>
  act(async () => {
    events.handlers.get(PREPARE_EVENT)?.({ payload })
  })

beforeEach(() => {
  vi.clearAllMocks()
  events.handlers.clear()
  useLiteRtLmInstallStore.setState({ justInstalled: null })
})

describe('LiteRtLmAccelerators', () => {
  it('shows no block where the core offers no accelerator (Linux, macOS)', async () => {
    core.liteRtLmAccelerators.mockResolvedValue(answer([], { build: '0.18.1/linux-x64' }))

    const { container } = render(<LiteRtLmAccelerators />)

    await waitFor(() => expect(core.liteRtLmAccelerators).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
    expect(core.prepareLiteRtLmAccelerators).not.toHaveBeenCalled()
  })

  it('shows nothing before the engine is installed', async () => {
    core.liteRtLmAccelerators.mockResolvedValue(answer([], { installed: false, build: null }))

    const { container } = render(<LiteRtLmAccelerators />)

    await waitFor(() => expect(core.liteRtLmAccelerators).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('shows OpenVINO with its NPU and size on a Lunar Lake laptop, and prepares nothing by itself', async () => {
    core.liteRtLmAccelerators.mockResolvedValue(answer([openvino()]))

    render(<LiteRtLmAccelerators />)

    const row = await screen.findByTestId('litert-accelerator-openvino')
    expect(within(row).getByText('providers:liteRtLm.accelerators.openvino {"version":"2026.4.1"}')).toBeInTheDocument()
    expect(
      within(row).getByText('providers:liteRtLm.accelerators.detail {"npu":"Lunar Lake","size":"85.0 MB"}')
    ).toBeInTheDocument()
    expect(within(row).getByText('providers:liteRtLm.accelerators.notPrepared')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'providers:liteRtLm.accelerators.prepare {"size":"85.0 MB"}' })).toBeInTheDocument()
    expect(core.prepareLiteRtLmAccelerators).not.toHaveBeenCalled()
  })

  it('prepares OpenVINO once by itself right after an install, with progress, then shows it ready', async () => {
    useLiteRtLmInstallStore.setState({ justInstalled: '0.18.1/win-x64' })
    core.liteRtLmAccelerators
      .mockResolvedValueOnce(answer([openvino()]))
      .mockResolvedValue(answer([openvino({ prepared: true })]))
    let finish: (value: unknown) => void = () => {}
    core.prepareLiteRtLmAccelerators.mockReturnValue(new Promise((resolve) => (finish = resolve)))

    render(<LiteRtLmAccelerators />)

    await waitFor(() => expect(core.prepareLiteRtLmAccelerators).toHaveBeenCalledWith(['openvino']))
    expect(useLiteRtLmInstallStore.getState().justInstalled).toBeNull()
    await emit({ accelerator: 'openvino', stage: 'downloading', fraction: 0.4 })
    expect(screen.getByText('providers:liteRtLm.accelerators.downloading {"percent":40}')).toBeInTheDocument()
    await emit({ accelerator: 'openvino', stage: 'done', fraction: 1 })
    await act(async () => finish({ accelerators: [{ name: 'openvino', prepared: true }] }))

    expect(await screen.findByText('providers:liteRtLm.accelerators.ready')).toBeInTheDocument()
    expect(core.prepareLiteRtLmAccelerators).toHaveBeenCalledTimes(1)
  })

  it('does not prepare by itself for a build it did not just install', async () => {
    useLiteRtLmInstallStore.setState({ justInstalled: '0.17.0/win-x64' })
    core.liteRtLmAccelerators.mockResolvedValue(answer([openvino()]))

    render(<LiteRtLmAccelerators />)

    const row = await screen.findByTestId('litert-accelerator-openvino')
    expect(within(row).getByText('providers:liteRtLm.accelerators.notPrepared')).toBeInTheDocument()
    expect(useLiteRtLmInstallStore.getState().justInstalled).toBe('0.17.0/win-x64')
    expect(core.prepareLiteRtLmAccelerators).not.toHaveBeenCalled()
  })

  it('shows a failed prepare with its reason and a retry', async () => {
    core.liteRtLmAccelerators.mockResolvedValue(answer([openvino()]))
    core.prepareLiteRtLmAccelerators.mockResolvedValue({
      accelerators: [{ name: 'openvino', prepared: false, reason: 'sha256 mismatch for openvino-2026.4.1.whl' }],
    })

    render(<LiteRtLmAccelerators />)
    fireEvent.click(await screen.findByRole('button', { name: /providers:liteRtLm.accelerators.prepare/ }))

    expect(await screen.findByText('sha256 mismatch for openvino-2026.4.1.whl')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'providers:liteRtLm.accelerators.retry' }))
    await waitFor(() => expect(core.prepareLiteRtLmAccelerators).toHaveBeenCalledTimes(2))
  })

  it('says why a prepare the core refused failed', async () => {
    core.liteRtLmAccelerators.mockResolvedValue(answer([openvino()]))
    core.prepareLiteRtLmAccelerators.mockRejectedValue({ code: 'NETWORK_ERROR', message: 'offline' })

    render(<LiteRtLmAccelerators />)
    fireEvent.click(await screen.findByRole('button', { name: /providers:liteRtLm.accelerators.prepare/ }))

    expect(
      await screen.findByText('providers:liteRtLm.accelerators.prepareFailed {"message":"offline"}')
    ).toBeInTheDocument()
  })

  it('shows the progress of a prepare already running when the page is opened again', async () => {
    core.liteRtLmAccelerators.mockResolvedValue(answer([openvino()]))

    render(<LiteRtLmAccelerators />)
    await screen.findByTestId('litert-accelerator-openvino')
    await waitFor(() => expect(events.handlers.has(PREPARE_EVENT)).toBe(true))
    await emit({ accelerator: 'openvino', stage: 'downloading', fraction: 0.7 })

    expect(screen.getByText('providers:liteRtLm.accelerators.downloading {"percent":70}')).toBeInTheDocument()
    // Nothing to start while it runs.
    expect(screen.queryByRole('button', { name: /providers:liteRtLm.accelerators.prepare/ })).not.toBeInTheDocument()
  })

  it('follows a prepare the core says is already running instead of failing', async () => {
    core.liteRtLmAccelerators.mockResolvedValue(answer([openvino()]))
    core.prepareLiteRtLmAccelerators.mockRejectedValue({ code: 'ENGINE_INSTALL_IN_PROGRESS', message: 'busy' })

    render(<LiteRtLmAccelerators />)
    fireEvent.click(await screen.findByRole('button', { name: /providers:liteRtLm.accelerators.prepare/ }))

    expect(await screen.findByText('providers:liteRtLm.accelerators.busy')).toBeInTheDocument()
    expect(screen.queryByText(/prepareFailed/)).not.toBeInTheDocument()
  })
})
