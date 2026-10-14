import { act, render, screen, fireEvent } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { seedServiceHub } from '@/test/service-hub'
import { PerformanceBenchmarkPanel } from '../PerformanceBenchmarkPanel'
import {
  runPerformanceBenchmarks,
  saveBenchmarkRun,
} from '@/lib/performance-benchmark'

vi.mock('@/lib/performance-benchmark', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/performance-benchmark')>()),
  runPerformanceBenchmarks: vi.fn(),
  saveBenchmarkRun: vi.fn(),
}))

beforeEach(() => {
  localStorage.clear()
  seedServiceHub({
    hardware: { getSystemUsage: vi.fn() } as never,
  })
})

it('shows a completed run even when persistence fails', async () => {
  vi.mocked(runPerformanceBenchmarks).mockResolvedValue({
    runId: 'completed',
    at: '2026-10-09',
    results: [
      {
        id: 'inference.ttft',
        name: 'Local API TTFT',
        unit: 'ms',
        higherIsBetter: false,
        values: [12],
        samples: 1,
        median: 12,
        p95: 12,
        min: 12,
        max: 12,
        stddev: 0,
      },
    ],
  })
  vi.mocked(saveBenchmarkRun).mockImplementation(() => {
    throw new Error('quota')
  })

  const view = render(<PerformanceBenchmarkPanel />)
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Run benchmark' }))
  })

  expect(await screen.findByText('Local API TTFT')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Run benchmark' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Set baseline' })).toBeEnabled()
  expect(screen.getByRole('alert')).toHaveTextContent('quota')
  view.unmount()
})
