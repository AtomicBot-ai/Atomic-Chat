import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Keys and their parameters are what the panel decides; the English copy lives in the locale file.
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  }),
}))

const navigate = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

const client = vi.hoisted(() => ({ probe: vi.fn() }))
vi.mock('@/services/managed-environment/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/managed-environment/client')>()),
  ...client,
}))

import { ManagedHubBlocked, ManagedHubChecking } from '../ManagedHubStatus'
import { TENSORRT_LLM_ENGINE } from '@/lib/managed-engines'
import { resetManagedPlansForTests, useManagedPlan } from '@/hooks/useManagedPlan'
import type { ManagedBlocker } from '@/services/managed-environment/types'

const driverTooOld: ManagedBlocker = {
  code: 'prerequisite-blocked',
  reason: 'driver-too-old',
  message:
    'The NVIDIA driver is too old: this engine needs 615.65.02 or newer, this machine has 580.95.05.',
  params: { required: '615.65.02', actual: '580.95.05' },
}

beforeEach(() => {
  vi.clearAllMocks()
  resetManagedPlansForTests()
})

describe('ManagedHubBlocked', () => {
  it('says which driver is needed and which one is there, with what to do and the way to the provider page', () => {
    render(<ManagedHubBlocked engine={TENSORRT_LLM_ENGINE} blockers={[driverTooOld]} />)

    expect(
      screen.getByText(
        'hub:tensorrt.blocker.driver-too-old {"required":"615.65.02","actual":"580.95.05"}'
      )
    ).toBeInTheDocument()
    expect(screen.getByText('hub:tensorrt.blocker.driver-too-old-fix')).toBeInTheDocument()
    expect(screen.getByText(driverTooOld.message)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'hub:tensorrt.blocked.openProvider' }))
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { providerName: 'tensorrt-llm' } })
    )
  })

  it('lists every blocker, in the core words where the Hub has none of its own, with its commands', () => {
    render(
      <ManagedHubBlocked
        engine={TENSORRT_LLM_ENGINE}
        blockers={[
          driverTooOld,
          {
            code: 'prerequisite-blocked',
            reason: 'unsupported-distribution',
            message: 'This distribution cannot be set up automatically.',
            commands: ['sudo pacman -S docker nvidia-container-toolkit'],
          },
        ]}
      />
    )

    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByText('This distribution cannot be set up automatically.')).toBeInTheDocument()
    expect(screen.getByText('sudo pacman -S docker nvidia-container-toolkit')).toBeInTheDocument()
  })

  it('checks the machine again on request', async () => {
    client.probe.mockResolvedValue({ blockers: [], descriptor_id: null })
    render(<ManagedHubBlocked engine={TENSORRT_LLM_ENGINE} blockers={[driverTooOld]} />)

    fireEvent.click(screen.getByRole('button', { name: 'hub:tensorrt.blocked.checkAgain' }))

    await waitFor(() => expect(client.probe).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'hub:tensorrt.blocked.checkAgain' })).toBeEnabled()
  })
})

describe('ManagedHubChecking', () => {
  it('claims nothing while the core has not answered', () => {
    render(<ManagedHubChecking engine={TENSORRT_LLM_ENGINE} />)
    expect(screen.getByRole('status')).toHaveTextContent('hub:tensorrt.checking')
  })

  it('says the check failed and offers to check again, instead of spinning forever', async () => {
    client.probe.mockRejectedValueOnce(new Error('core is restarting'))
    const { result } = renderHook(() => useManagedPlan('tensorrt-llm'))
    await waitFor(() => expect(result.current.error).toBe('core is restarting'))

    render(<ManagedHubChecking engine={TENSORRT_LLM_ENGINE} />)

    expect(screen.getByText('core is restarting')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    client.probe.mockResolvedValue({ blockers: [], descriptor_id: null })
    fireEvent.click(screen.getByRole('button', { name: 'hub:tensorrt.blocked.checkAgain' }))
    await waitFor(() => expect(client.probe).toHaveBeenCalledTimes(2))
    expect(await screen.findByRole('status')).toHaveTextContent('hub:tensorrt.checking')
  })
})
