import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EnvironmentSnapshot } from '@/services/managed-environment/types'
import { selectEnvironment, useManagedEnvironmentStore } from '@/stores/managed-environment-store'

const mocks = vi.hoisted(() => ({
  readSnapshot: vi.fn(),
}))

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ events: () => ({ listen: async () => () => {} }) }),
}))

vi.mock('@/services/managed-environment/client', () => ({
  readManagedSnapshot: mocks.readSnapshot,
}))

import { useManagedEnvironmentSync } from '../useManagedEnvironmentSync'

const environment = (executor: EnvironmentSnapshot['executor']): EnvironmentSnapshot => ({
  schema_version: 1,
  environment_id: 'env-1',
  instance_id: 'core-a',
  revision: 1,
  executor,
  availability: 'setup-required',
  gpus: [],
  blockers: [],
  selinux: null,
  installations: [],
  active_operation_id: null,
  minimum_app_version: null,
})

const platform = (flags: { linux?: boolean; windows?: boolean; macos?: boolean }) => {
  const global = globalThis as Record<string, unknown>
  global.IS_LINUX = flags.linux ?? false
  global.IS_WINDOWS = flags.windows ?? false
  global.IS_MACOS = flags.macos ?? false
}

describe('useManagedEnvironmentSync', () => {
  beforeEach(() => {
    useManagedEnvironmentStore.getState().reset()
  })

  afterEach(() => platform({}))

  it('follows the core on Linux', async () => {
    platform({ linux: true })
    mocks.readSnapshot.mockResolvedValue({
      instance_id: 'core-a',
      environments: [environment('linux-docker')],
      environment_operations: [],
    })
    renderHook(() => useManagedEnvironmentSync())

    await waitFor(() =>
      expect(selectEnvironment(useManagedEnvironmentStore.getState())?.executor).toBe('linux-docker')
    )
  })

  it('follows the core on Windows, where it owns a WSL environment (change add-tensorrt-llm-windows)', async () => {
    // On Windows on ARM the core answers `unsupported` itself, so the OS is the only gate here.
    platform({ windows: true })
    mocks.readSnapshot.mockResolvedValue({
      instance_id: 'core-a',
      environments: [environment('wsl-docker')],
      environment_operations: [],
    })
    renderHook(() => useManagedEnvironmentSync())

    await waitFor(() =>
      expect(selectEnvironment(useManagedEnvironmentStore.getState())?.executor).toBe('wsl-docker')
    )
  })

  it('reads nothing on macOS, where the core has no managed environment', async () => {
    platform({ macos: true })
    mocks.readSnapshot.mockResolvedValue({
      instance_id: 'core-a',
      environments: [environment('linux-docker')],
      environment_operations: [],
    })
    renderHook(() => useManagedEnvironmentSync())

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(selectEnvironment(useManagedEnvironmentStore.getState())).toBeUndefined()
  })
})
