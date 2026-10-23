import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { seedServiceHub } from '@/test/service-hub'
import type { ServiceHub } from '@/services'

vi.mock('@tanstack/react-router', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createFileRoute: () => (config: any) => config,
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const usage = vi.hoisted(() => ({
  state: {
    hardwareData: {
      cpu: { name: 'Apple M3', core_count: 8, arch: 'arm64' },
      total_memory: 16384,
      gpus: [] as unknown[],
    },
    systemUsage: { cpu: 19.123, used_memory: 10745, gpus: [] as unknown[] },
  },
}))

vi.mock('@/hooks/useHardware', () => ({
  useHardware: () => ({
    hardwareData: usage.state.hardwareData,
    systemUsage: usage.state.systemUsage,
    updateSystemUsage: vi.fn(),
  }),
}))

vi.mock('@/hooks/useLlamacppDevices', () => ({
  useLlamacppDevices: () => ({ devices: [], fetchDevices: vi.fn() }),
}))

import { Route } from '../system-monitor'

const SystemMonitor = Route.component as React.ComponentType

// QA 2.2.23 #14: the usage bars had no names and announced other values
// than the percentages beside them.
describe('System Monitor usage meters', () => {
  beforeEach(() => {
    global.IS_MACOS = true
    usage.state.systemUsage = { cpu: 19.123, used_memory: 10745, gpus: [] }
    seedServiceHub({
      hardware: {
        getSystemUsage: vi.fn().mockResolvedValue(null),
      } as unknown as ReturnType<ServiceHub['hardware']>,
    })
  })

  it('names the CPU and memory meters and announces the percentages shown', () => {
    render(<SystemMonitor />)

    const cpu = screen.getByRole('progressbar', {
      name: 'system-monitor:cpuUsage',
    })
    expect(cpu).toHaveAttribute('aria-valuenow', '19.123')
    expect(cpu).toHaveAttribute('aria-valuetext', '19.12%')
    expect(screen.getByText('19.12%')).toBeInTheDocument()

    const memory = screen.getByRole('progressbar', {
      name: 'system-monitor:memoryUsage',
    })
    expect(memory).toHaveAttribute('aria-valuemin', '0')
    expect(memory).toHaveAttribute('aria-valuemax', '100')
    expect(memory).toHaveAttribute('aria-valuetext', '65.58%')
    expect(screen.getByText('65.58%')).toBeInTheDocument()
  })

  it('follows the next usage poll', () => {
    const { rerender } = render(<SystemMonitor />)

    usage.state.systemUsage = { cpu: 73.5, used_memory: 4096, gpus: [] }
    rerender(<SystemMonitor />)

    const cpu = screen.getByRole('progressbar', {
      name: 'system-monitor:cpuUsage',
    })
    expect(cpu).toHaveAttribute('aria-valuenow', '73.5')
    expect(cpu).toHaveAttribute('aria-valuetext', '73.50%')
    expect(
      screen.getByRole('progressbar', { name: 'system-monitor:memoryUsage' })
    ).toHaveAttribute('aria-valuetext', '25.00%')
  })
})
