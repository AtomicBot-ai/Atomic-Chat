import { beforeEach, describe, expect, it, vi } from 'vitest'

const installedIds = vi.hoisted(() => new Set<string>())

vi.mock('@/lib/decision/models', () => ({
  isDecisionModelInstalled: vi.fn(async (model: { id: string }) =>
    installedIds.has(model.id)
  ),
}))

vi.mock('@/services/decision-catalog-registry', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/services/decision-catalog-registry')
    >()
  return {
    ...actual,
    fetchDecisionCatalog: vi.fn(async () => ({
      catalog: actual.getBaselineDecisionCatalog(),
      source: 'baseline',
    })),
  }
})

import { isDecisionModelInstalled } from '@/lib/decision/models'
import { seedServiceHub } from '@/test/service-hub'
import type {
  DecisionEvent,
  DecisionService,
  DecisionStatus,
} from '@/services/decision/types'

import { toDecisionError, useDecisionStore } from '../decision-store'

const status = (state: DecisionStatus['state']): DecisionStatus =>
  ({ state, error: null }) as unknown as DecisionStatus

const fakeService = (supported = true) => {
  let handler: ((event: DecisionEvent) => void) | null = null
  const unsubscribe = vi.fn()
  const service = {
    isSupported: () => supported,
    getConfig: vi.fn().mockResolvedValue({
      config: { model_path: 'decision/models/laya' },
      status: status('idle'),
    }),
    subscribe: vi.fn((h: (event: DecisionEvent) => void) => {
      handler = h
      return unsubscribe
    }),
  }
  seedServiceHub({ decision: service as unknown as DecisionService })
  return {
    service,
    unsubscribe,
    emit: (event: DecisionEvent) => handler?.(event),
  }
}

const initial = useDecisionStore.getState()

beforeEach(() => {
  installedIds.clear()
  useDecisionStore.setState(initial, true)
})

describe('toDecisionError', () => {
  it('keeps the core error shape', () => {
    expect(
      toDecisionError({
        code: 'DECISION_NOT_CONFIGURED',
        message: 'm',
        details: 'd',
      })
    ).toEqual({ code: 'DECISION_NOT_CONFIGURED', message: 'm', details: 'd' })
  })

  it('wraps anything else', () => {
    expect(toDecisionError(new Error('boom'))).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'boom',
    })
    expect(toDecisionError('nope')).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'nope',
    })
  })
})

describe('useDecisionStore', () => {
  it('starts from the baseline catalog', () => {
    expect(useDecisionStore.getState().catalog.models.length).toBeGreaterThan(0)
  })

  it('reads the config and status on refresh', async () => {
    fakeService()
    await useDecisionStore.getState().refresh()
    expect(useDecisionStore.getState().config?.model_path).toBe(
      'decision/models/laya'
    )
    expect(useDecisionStore.getState().status?.state).toBe('idle')
  })

  it('keeps a failed refresh as the error', async () => {
    const { service } = fakeService()
    service.getConfig.mockRejectedValue({
      code: 'CORE_UNAVAILABLE',
      message: 'down',
    })
    await useDecisionStore.getState().refresh()
    expect(useDecisionStore.getState().error?.code).toBe('CORE_UNAVAILABLE')
  })

  it('marks which catalog models are on disk', async () => {
    const [first] = useDecisionStore.getState().catalog.models
    installedIds.add(first.id)
    expect(useDecisionStore.getState().installedRead).toBe(false)
    await useDecisionStore.getState().refreshInstalled()
    const { installed, installedRead } = useDecisionStore.getState()
    expect(installedRead).toBe(true)
    expect(installed[first.id]).toBe(true)
    expect(Object.values(installed).filter(Boolean)).toHaveLength(1)
  })

  it('counts a failed read of the disk as read, so nothing waits on it', async () => {
    vi.mocked(isDecisionModelInstalled).mockRejectedValueOnce(
      new Error('EACCES')
    )
    await expect(
      useDecisionStore.getState().refreshInstalled()
    ).rejects.toThrow('EACCES')
    expect(useDecisionStore.getState().installedRead).toBe(true)
    expect(useDecisionStore.getState().installed).toEqual({})
  })

  it('follows the core events once bound', async () => {
    const { service, unsubscribe, emit } = fakeService()
    const unbind = useDecisionStore.getState().bind()
    await vi.waitFor(() =>
      expect(useDecisionStore.getState().status?.state).toBe('idle')
    )

    emit({
      type: 'error',
      error: { code: 'DECISION_START_FAILED', message: 'x' },
    })
    expect(useDecisionStore.getState().error?.code).toBe(
      'DECISION_START_FAILED'
    )

    emit({ type: 'state', status: status('ready') })
    expect(useDecisionStore.getState().status?.state).toBe('ready')
    expect(useDecisionStore.getState().error).toBeNull()

    emit({ type: 'reset' })
    await vi.waitFor(() => expect(service.getConfig).toHaveBeenCalledTimes(2))

    unbind()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('does nothing off the desktop', () => {
    const { service } = fakeService(false)
    useDecisionStore.getState().bind()()
    expect(service.subscribe).not.toHaveBeenCalled()
    expect(useDecisionStore.getState().status).toBeNull()
    // Nothing to read is an answer: the empty map is what is installed.
    expect(useDecisionStore.getState().installedRead).toBe(true)
  })
})
