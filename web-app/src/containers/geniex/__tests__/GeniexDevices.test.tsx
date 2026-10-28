import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  geniexAccelerators: vi.fn(),
  prepareGeniexAccelerators: vi.fn(),
}))
vi.mock('@/services/geniex/core', () => core)

import { GeniexDevices } from '../GeniexDevices'
import type { GeniexAccelerator, GeniexAccelerators as Answer } from '@/services/geniex/types'

const device = (name: 'npu' | 'gpu'): GeniexAccelerator => ({
  name,
  device: name,
  version: '0.9.3',
  size_bytes: 0,
  prepared: true,
})

function answer(accelerators: GeniexAccelerator[], extra: Partial<Answer> = {}): Answer {
  return { installed: true, build: '0.9.3/win-arm64', chip: 'x-elite', accelerators, error: null, ...extra }
}

beforeEach(() => vi.clearAllMocks())

describe('GeniexDevices', () => {
  it('lists the NPU and the GPU the library found, each ready, with nothing to prepare', async () => {
    // spec geniex-desktop "Первый запуск": after the install the page shows NPU and GPU as found.
    core.geniexAccelerators.mockResolvedValue(answer([device('npu'), device('gpu')]))

    render(<GeniexDevices />)

    expect(await screen.findByTestId('geniex-device-npu')).toHaveTextContent('providers:geniex.devices.ready')
    expect(screen.getByTestId('geniex-device-gpu')).toHaveTextContent('providers:geniex.devices.ready')
    expect(screen.getByText('providers:geniex.devices.npu')).toBeInTheDocument()
    expect(screen.getByText('providers:geniex.devices.gpu')).toBeInTheDocument()
    expect(screen.queryByText('providers:geniex.devices.npuDriverHint')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /prepare/i })).not.toBeInTheDocument()
    expect(core.prepareGeniexAccelerators).not.toHaveBeenCalled()
  })

  it('shows only the GPU and explains the Qualcomm NPU driver when the library found no NPU', async () => {
    // spec geniex-desktop "Без драйвера NPU".
    core.geniexAccelerators.mockResolvedValue(answer([device('gpu')]))

    render(<GeniexDevices />)

    expect(await screen.findByTestId('geniex-device-gpu')).toHaveTextContent('providers:geniex.devices.ready')
    expect(screen.queryByTestId('geniex-device-npu')).not.toBeInTheDocument()
    expect(screen.getByText('providers:geniex.devices.npuDriverHint')).toBeInTheDocument()
  })

  it('shows nothing before the SDK is installed', async () => {
    core.geniexAccelerators.mockResolvedValue(answer([], { installed: false, build: null }))

    const { container } = render(<GeniexDevices />)

    await waitFor(() => expect(core.geniexAccelerators).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the core’s error with a way to ask again', async () => {
    core.geniexAccelerators
      .mockResolvedValueOnce(answer([], { error: 'install.json is unreadable' }))
      .mockResolvedValueOnce(answer([device('npu'), device('gpu')]))

    render(<GeniexDevices />)

    expect(await screen.findByText('install.json is unreadable')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'providers:geniex.devices.checkAgain' }))
    expect(await screen.findByTestId('geniex-device-npu')).toBeInTheDocument()
  })
})
