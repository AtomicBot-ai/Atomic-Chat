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
  foundryLocalAccelerators: vi.fn(),
  prepareFoundryLocalAccelerators: vi.fn(),
}))
vi.mock('@/services/foundry-local/core', () => core)

const events = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    events.handlers.set(name, handler)
    return () => events.handlers.delete(name)
  }),
}))

import { FoundryLocalAccelerators } from '../FoundryLocalAccelerators'
import { useFoundryLocalInstallStore } from '../install-store'
import type {
  FoundryLocalAccelerator,
  FoundryLocalAccelerators as Answer,
} from '@/services/foundry-local/types'

const PREPARE_EVENT = 'atomic-core://foundry-local:accelerators'

function answer(accelerators: FoundryLocalAccelerator[], extra: Partial<Answer> = {}): Answer {
  return {
    installed: true,
    build: 'v2.1.0/win-x64',
    version: '2.1.0',
    c_api_version: 2,
    probed_at: 1,
    accelerators,
    error: null,
    ...extra,
  }
}

const openvino = (extra: Partial<FoundryLocalAccelerator> = {}): FoundryLocalAccelerator => ({
  name: 'OpenVINOExecutionProvider',
  execution_provider: 'openvino',
  device: 'gpu/npu',
  prepared: false,
  ...extra,
})
const cuda = (extra: Partial<FoundryLocalAccelerator> = {}): FoundryLocalAccelerator => ({
  name: 'CUDAExecutionProvider',
  execution_provider: 'cuda',
  device: 'gpu',
  prepared: false,
  ...extra,
})
const webgpu = (extra: Partial<FoundryLocalAccelerator> = {}): FoundryLocalAccelerator => ({
  name: 'WebGpuExecutionProvider',
  execution_provider: 'webgpu',
  device: 'gpu',
  prepared: false,
  ...extra,
})

const row = (name: string) => screen.getByTestId(`foundry-accelerator-${name}`)

beforeEach(() => {
  vi.clearAllMocks()
  events.handlers.clear()
  useFoundryLocalInstallStore.setState({ justInstalled: null })
})

describe('FoundryLocalAccelerators', () => {
  it('shows a prepared accelerator as ready and offers nothing to prepare', async () => {
    core.foundryLocalAccelerators.mockResolvedValue(answer([webgpu({ prepared: true })]))

    render(<FoundryLocalAccelerators />)

    await waitFor(() =>
      expect(within(row('WebGpuExecutionProvider')).getByText('providers:foundryLocal.accelerators.ready')).toBeInTheDocument()
    )
    expect(screen.queryByRole('button', { name: /providers:foundryLocal.accelerators.prepare\b/ })).not.toBeInTheDocument()
  })

  it('shows OpenVINO found but not prepared, with Prepare and the size warning (first run on an NPU laptop)', async () => {
    core.foundryLocalAccelerators.mockResolvedValue(answer([openvino()]))

    render(<FoundryLocalAccelerators />)

    await waitFor(() =>
      expect(within(row('OpenVINOExecutionProvider')).getByText('providers:foundryLocal.accelerators.notPrepared')).toBeInTheDocument()
    )
    expect(screen.getByText('providers:foundryLocal.accelerators.sizeWarning')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'providers:foundryLocal.accelerators.prepare' })).toBeEnabled()
  })

  it('hides an accelerator no variant runs on (TensorRT-RTX) and never prepares it', async () => {
    core.foundryLocalAccelerators.mockResolvedValue(
      answer([openvino(), { name: 'NvTensorRTRTXExecutionProvider', execution_provider: null, device: 'gpu', prepared: false }])
    )
    core.prepareFoundryLocalAccelerators.mockResolvedValue({
      accelerators: [{ name: 'OpenVINOExecutionProvider', prepared: true }],
    })

    render(<FoundryLocalAccelerators />)
    await screen.findByTestId('foundry-accelerator-OpenVINOExecutionProvider')

    expect(screen.queryByTestId('foundry-accelerator-NvTensorRTRTXExecutionProvider')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'providers:foundryLocal.accelerators.prepare' }))
    await waitFor(() =>
      expect(core.prepareFoundryLocalAccelerators).toHaveBeenCalledWith(['OpenVINOExecutionProvider'])
    )
  })

  it('shows progress from the core’s events while a prepare runs, then the answer read again', async () => {
    core.foundryLocalAccelerators
      .mockResolvedValueOnce(answer([webgpu(), openvino()]))
      .mockResolvedValueOnce(answer([webgpu({ prepared: true }), openvino({ prepared: true })]))
    let finish: (value: unknown) => void = () => {}
    core.prepareFoundryLocalAccelerators.mockReturnValue(new Promise((resolve) => (finish = resolve)))

    render(<FoundryLocalAccelerators />)
    await screen.findByTestId('foundry-accelerator-WebGpuExecutionProvider')
    fireEvent.click(screen.getByRole('button', { name: 'providers:foundryLocal.accelerators.prepare' }))
    await waitFor(() => expect(events.handlers.has(PREPARE_EVENT)).toBe(true))

    act(() => {
      events.handlers.get(PREPARE_EVENT)?.({
        payload: { accelerator: 'WebGpuExecutionProvider', stage: 'downloading', fraction: 0.4 },
      })
      // Windows ML reports no fraction.
      events.handlers.get(PREPARE_EVENT)?.({
        payload: { accelerator: 'OpenVINOExecutionProvider', stage: 'started', fraction: null },
      })
    })
    expect(within(row('WebGpuExecutionProvider')).getByText('providers:foundryLocal.accelerators.downloading {"percent":40}')).toBeInTheDocument()
    expect(within(row('OpenVINOExecutionProvider')).getByText('providers:foundryLocal.accelerators.preparing')).toBeInTheDocument()

    await act(async () => {
      finish({
        accelerators: [
          { name: 'WebGpuExecutionProvider', prepared: true },
          { name: 'OpenVINOExecutionProvider', prepared: true },
        ],
      })
    })
    await waitFor(() =>
      expect(within(row('OpenVINOExecutionProvider')).getByText('providers:foundryLocal.accelerators.ready')).toBeInTheDocument()
    )
    expect(within(row('WebGpuExecutionProvider')).getByText('providers:foundryLocal.accelerators.ready')).toBeInTheDocument()
  })

  it('shows WebGPU ready and CUDA with its reason and a retry when CUDA failed', async () => {
    core.foundryLocalAccelerators.mockResolvedValue(
      answer([webgpu({ prepared: true }), cuda({ reason: 'libcublasLt.so.12: cannot open shared object file' })])
    )
    core.prepareFoundryLocalAccelerators.mockResolvedValue({
      accelerators: [{ name: 'CUDAExecutionProvider', prepared: false, reason: 'still missing' }],
    })

    render(<FoundryLocalAccelerators />)

    const cudaRow = await screen.findByTestId('foundry-accelerator-CUDAExecutionProvider')
    expect(within(row('WebGpuExecutionProvider')).getByText('providers:foundryLocal.accelerators.ready')).toBeInTheDocument()
    expect(within(cudaRow).getByText('libcublasLt.so.12: cannot open shared object file')).toBeInTheDocument()
    fireEvent.click(within(cudaRow).getByRole('button', { name: 'providers:foundryLocal.accelerators.retry' }))
    await waitFor(() =>
      expect(core.prepareFoundryLocalAccelerators).toHaveBeenCalledWith(['CUDAExecutionProvider'])
    )
  })

  it('follows a prepare it did not start (the page was opened again while one ran)', async () => {
    core.foundryLocalAccelerators.mockResolvedValue(answer([cuda(), webgpu()]))

    render(<FoundryLocalAccelerators />)
    await screen.findByTestId('foundry-accelerator-CUDAExecutionProvider')
    await waitFor(() => expect(events.handlers.has(PREPARE_EVENT)).toBe(true))

    act(() => {
      events.handlers.get(PREPARE_EVENT)?.({
        payload: { accelerator: 'CUDAExecutionProvider', stage: 'downloading', fraction: 0.3 },
      })
    })

    expect(within(row('CUDAExecutionProvider')).getByText('providers:foundryLocal.accelerators.downloading {"percent":30}')).toBeInTheDocument()
    // Nothing to start while the core prepares: a click would only be refused.
    expect(screen.queryByRole('button', { name: 'providers:foundryLocal.accelerators.prepare' })).not.toBeInTheDocument()
    expect(core.prepareFoundryLocalAccelerators).not.toHaveBeenCalled()
  })

  it('shows an accelerator ready as soon as the core reports it done, before the prepare answers', async () => {
    core.foundryLocalAccelerators.mockResolvedValue(answer([openvino(), cuda()]))
    core.prepareFoundryLocalAccelerators.mockReturnValue(new Promise(() => {}))

    render(<FoundryLocalAccelerators />)
    await screen.findByTestId('foundry-accelerator-OpenVINOExecutionProvider')
    fireEvent.click(screen.getByRole('button', { name: 'providers:foundryLocal.accelerators.prepare' }))
    await waitFor(() => expect(core.prepareFoundryLocalAccelerators).toHaveBeenCalled())

    act(() => {
      events.handlers.get(PREPARE_EVENT)?.({
        payload: { accelerator: 'OpenVINOExecutionProvider', stage: 'done', fraction: null },
      })
    })

    expect(within(row('OpenVINOExecutionProvider')).getByText('providers:foundryLocal.accelerators.ready')).toBeInTheDocument()
    expect(within(row('CUDAExecutionProvider')).getByText('providers:foundryLocal.accelerators.preparing')).toBeInTheDocument()
  })

  it('shows the reason and a retry for an accelerator the core reports failed', async () => {
    core.foundryLocalAccelerators.mockResolvedValue(answer([cuda(), webgpu()]))
    core.prepareFoundryLocalAccelerators.mockReturnValue(new Promise(() => {}))

    render(<FoundryLocalAccelerators />)
    await screen.findByTestId('foundry-accelerator-CUDAExecutionProvider')
    fireEvent.click(screen.getByRole('button', { name: 'providers:foundryLocal.accelerators.prepare' }))
    await waitFor(() => expect(core.prepareFoundryLocalAccelerators).toHaveBeenCalled())

    act(() => {
      events.handlers.get(PREPARE_EVENT)?.({
        payload: { accelerator: 'CUDAExecutionProvider', stage: 'failed', fraction: null, reason: 'connection reset' },
      })
    })

    const cudaRow = row('CUDAExecutionProvider')
    expect(within(cudaRow).getByText('connection reset')).toBeInTheDocument()
    // WebGPU is still being prepared: the retry waits for that prepare to end.
    expect(within(cudaRow).getByRole('button', { name: 'providers:foundryLocal.accelerators.retry' })).toBeDisabled()
  })

  it('follows the running prepare when its own is refused as busy, and reads the answer when it ends', async () => {
    core.foundryLocalAccelerators
      .mockResolvedValueOnce(answer([openvino(), cuda()]))
      .mockResolvedValue(answer([openvino({ prepared: true }), cuda({ prepared: true })]))
    core.prepareFoundryLocalAccelerators.mockRejectedValue({
      code: 'ENGINE_INSTALL_IN_PROGRESS',
      message: 'A prepare is running.',
    })

    render(<FoundryLocalAccelerators />)
    await screen.findByTestId('foundry-accelerator-OpenVINOExecutionProvider')
    fireEvent.click(screen.getByRole('button', { name: 'providers:foundryLocal.accelerators.prepare' }))

    expect(await screen.findByText('providers:foundryLocal.accelerators.busy')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'providers:foundryLocal.accelerators.prepare' })).not.toBeInTheDocument()
    expect(within(row('OpenVINOExecutionProvider')).getByText('providers:foundryLocal.accelerators.preparing')).toBeInTheDocument()
    expect(within(row('CUDAExecutionProvider')).getByText('providers:foundryLocal.accelerators.preparing')).toBeInTheDocument()

    act(() => {
      events.handlers.get(PREPARE_EVENT)?.({
        payload: { accelerator: 'CUDAExecutionProvider', stage: 'downloading', fraction: 0.5 },
      })
    })
    expect(within(row('CUDAExecutionProvider')).getByText('providers:foundryLocal.accelerators.downloading {"percent":50}')).toBeInTheDocument()

    act(() => {
      events.handlers.get(PREPARE_EVENT)?.({
        payload: { accelerator: 'CUDAExecutionProvider', stage: 'done', fraction: null },
      })
      events.handlers.get(PREPARE_EVENT)?.({
        payload: { accelerator: 'OpenVINOExecutionProvider', stage: 'done', fraction: null },
      })
    })

    await waitFor(() => expect(screen.queryByText('providers:foundryLocal.accelerators.busy')).not.toBeInTheDocument())
    expect(core.foundryLocalAccelerators).toHaveBeenCalledTimes(2)
    expect(within(row('OpenVINOExecutionProvider')).getByText('providers:foundryLocal.accelerators.ready')).toBeInTheDocument()
    expect(within(row('CUDAExecutionProvider')).getByText('providers:foundryLocal.accelerators.ready')).toBeInTheDocument()
  })

  it('says why when another prepare is already running', async () => {
    core.foundryLocalAccelerators.mockResolvedValue(answer([openvino()]))
    core.prepareFoundryLocalAccelerators.mockRejectedValue({
      code: 'ENGINE_INSTALL_IN_PROGRESS',
      message: 'A prepare is running.',
    })

    render(<FoundryLocalAccelerators />)
    await screen.findByTestId('foundry-accelerator-OpenVINOExecutionProvider')
    fireEvent.click(screen.getByRole('button', { name: 'providers:foundryLocal.accelerators.prepare' }))

    expect(await screen.findByText('providers:foundryLocal.accelerators.busy')).toBeInTheDocument()
  })

  it('shows the probe’s failure with a way to check again', async () => {
    core.foundryLocalAccelerators
      .mockResolvedValueOnce(answer([], { error: 'libatomic.so.1: cannot open shared object file' }))
      .mockResolvedValueOnce(answer([webgpu({ prepared: true })]))

    render(<FoundryLocalAccelerators />)

    expect(await screen.findByText('libatomic.so.1: cannot open shared object file')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'providers:foundryLocal.accelerators.checkAgain' }))
    await screen.findByTestId('foundry-accelerator-WebGpuExecutionProvider')
    expect(core.foundryLocalAccelerators).toHaveBeenLastCalledWith({ force: true })
  })

  it('shows nothing before the engine is installed', async () => {
    core.foundryLocalAccelerators.mockResolvedValue(answer([], { installed: false, build: null }))

    const { container } = render(<FoundryLocalAccelerators />)

    await waitFor(() => expect(core.foundryLocalAccelerators).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('lets the person try again when the progress events cannot be followed', async () => {
    core.foundryLocalAccelerators.mockResolvedValue(answer([openvino()]))
    const { listen } = await import('@tauri-apps/api/event')
    // Once when the block opens, once more when Prepare tries to follow again.
    vi.mocked(listen)
      .mockRejectedValueOnce(new Error('event plugin not ready'))
      .mockRejectedValueOnce(new Error('event plugin not ready'))

    render(<FoundryLocalAccelerators />)
    await screen.findByTestId('foundry-accelerator-OpenVINOExecutionProvider')
    fireEvent.click(screen.getByRole('button', { name: 'providers:foundryLocal.accelerators.prepare' }))

    expect(await screen.findByText(/providers:foundryLocal.accelerators.prepareFailed/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'providers:foundryLocal.accelerators.prepare' })).toBeEnabled()
  })

  it('prepares every accelerator a variant runs on by itself right after the engine was installed', async () => {
    useFoundryLocalInstallStore.setState({ justInstalled: 'v2.1.0/win-x64' })
    core.foundryLocalAccelerators
      .mockResolvedValueOnce(
        answer([openvino(), cuda(), { name: 'NvTensorRTRTXExecutionProvider', execution_provider: null, device: 'gpu', prepared: false }])
      )
      .mockResolvedValue(answer([openvino({ prepared: true }), cuda({ prepared: true })]))
    core.prepareFoundryLocalAccelerators.mockResolvedValue({
      accelerators: [
        { name: 'OpenVINOExecutionProvider', prepared: true },
        { name: 'CUDAExecutionProvider', prepared: true },
      ],
    })

    render(<FoundryLocalAccelerators />)

    await waitFor(() =>
      expect(core.prepareFoundryLocalAccelerators).toHaveBeenCalledWith([
        'OpenVINOExecutionProvider',
        'CUDAExecutionProvider',
      ])
    )
    await waitFor(() =>
      expect(within(row('CUDAExecutionProvider')).getByText('providers:foundryLocal.accelerators.ready')).toBeInTheDocument()
    )
    // Once: opening the page again later prepares nothing by itself.
    expect(useFoundryLocalInstallStore.getState().justInstalled).toBeNull()
  })

  it('prepares nothing by itself for a build it was not told was just installed', async () => {
    useFoundryLocalInstallStore.setState({ justInstalled: 'v2.0.0/win-x64' })
    core.foundryLocalAccelerators.mockResolvedValue(answer([openvino()]))

    render(<FoundryLocalAccelerators />)

    const openvinoRow = await screen.findByTestId('foundry-accelerator-OpenVINOExecutionProvider')
    expect(within(openvinoRow).getByText('providers:foundryLocal.accelerators.notPrepared')).toBeInTheDocument()
    expect(useFoundryLocalInstallStore.getState().justInstalled).toBe('v2.0.0/win-x64')
    expect(core.prepareFoundryLocalAccelerators).not.toHaveBeenCalled()
  })

  it('offers no Prepare while a prepare runs, and marks what it prepares at once', async () => {
    core.foundryLocalAccelerators.mockResolvedValue(answer([webgpu(), cuda()]))
    core.prepareFoundryLocalAccelerators.mockReturnValue(new Promise(() => {}))

    render(<FoundryLocalAccelerators />)
    await screen.findByTestId('foundry-accelerator-WebGpuExecutionProvider')
    fireEvent.click(screen.getByRole('button', { name: 'providers:foundryLocal.accelerators.prepare' }))

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'providers:foundryLocal.accelerators.prepare' })).not.toBeInTheDocument()
    )
    // No event from the core yet: both still read as being prepared, not as "not prepared".
    expect(within(row('WebGpuExecutionProvider')).getByText('providers:foundryLocal.accelerators.preparing')).toBeInTheDocument()
    expect(within(row('CUDAExecutionProvider')).getByText('providers:foundryLocal.accelerators.preparing')).toBeInTheDocument()
  })
})
