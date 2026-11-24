import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PromptProgress } from '../PromptProgress'
import { useAppState } from '@/hooks/useAppState'

const inference = vi.hoisted(() => ({ phase: 'ready' }))
vi.mock('@/hooks/useInferenceStatus', () => ({
  useInferenceStatus: () => inference,
}))

// Mock the useAppState hook
vi.mock('@/hooks/useAppState', () => ({
  useAppState: vi.fn(),
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      key === 'activity.reading'
        ? `Reading: ${options?.count}%`
        : key === 'activity.working'
          ? 'Working'
          : key,
  }),
}))

const mockUseAppState = useAppState as ReturnType<typeof vi.fn>

describe('PromptProgress', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    inference.phase = 'ready'
  })

  it.each(['starting', 'restarting'])(
    'shows model loading during %s, then the reading progress',
    (phase) => {
      mockUseAppState.mockReturnValue({ processed: 50, total: 100 })
      inference.phase = phase
      const view = render(<PromptProgress />)
      expect(screen.getByText('activity.loadingModel')).toBeVisible()
      expect(screen.queryByText('Working')).toBeNull()
      expect(screen.queryByText(/Reading:/)).toBeNull()
      inference.phase = 'ready'
      view.rerender(<PromptProgress />)
      expect(screen.getByText('Reading: 50%')).toBeVisible()
    }
  )

  it('shows Working before the engine reports how far it has read', () => {
    mockUseAppState.mockReturnValue(undefined)
    render(<PromptProgress />)
    expect(screen.getByText('Working')).toBeVisible()
  })

  it('shows the reading percentage in its label, and the bar on demand', async () => {
    const user = userEvent.setup()
    const mockProgress = {
      cache: 0,
      processed: 75,
      time_ms: 1500,
      total: 150,
    }

    mockUseAppState.mockReturnValue(mockProgress)

    render(<PromptProgress />)

    expect(screen.getByText('Reading: 50%')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Reading: 50%' }))
    expect(screen.getByRole('progressbar')).toHaveAttribute(
      'aria-valuenow',
      '50'
    )
  })

  it('should handle zero total gracefully', () => {
    const mockProgress = {
      cache: 0,
      processed: 0,
      time_ms: 0,
      total: 0,
    }

    mockUseAppState.mockReturnValue(mockProgress)

    render(<PromptProgress />)

    expect(screen.getByRole('button', { name: /working/i })).toBeDisabled()
    expect(screen.queryByText(/reading/i)).not.toBeInTheDocument()
  })
})
