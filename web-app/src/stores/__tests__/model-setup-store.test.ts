import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useModelSetupStore } from '@/stores/model-setup-store'
import type { ModelSetup } from '@/services/model-setup/types'

const setup = (id: string, revision: number, stage: ModelSetup['stage']) =>
  ({
    setup_id: id,
    revision,
    stage,
    request: { repo: 'o/r', file: 'f.gguf' },
  }) as ModelSetup

const verdict = {
  outcome: 'compatible',
  provider: null,
  requires: [],
  evidence: 'rules',
  rules_version: 1,
  reason: 'r',
} as const

describe('useModelSetupStore', () => {
  beforeEach(() => {
    useModelSetupStore.setState({
      setups: {},
      progress: {},
      speeds: {},
      verdicts: {},
    })
  })

  afterEach(() => vi.useRealTimers())

  it('keeps the newest revision of every setup it hears about', () => {
    const { apply } = useModelSetupStore.getState()
    apply({ type: 'changed', setup: setup('a', 2, 'downloading_model') })
    apply({ type: 'changed', setup: setup('a', 1, 'queued') })
    apply({ type: 'changed', setup: setup('b', 1, 'queued') })

    const { setups } = useModelSetupStore.getState()
    expect(setups.a.stage).toBe('downloading_model')
    expect(Object.keys(setups)).toEqual(['a', 'b'])
  })

  it('records the bytes of each download by task id', () => {
    useModelSetupStore
      .getState()
      .apply({ type: 'progress', taskId: 't', transferred: 5, total: 10 })
    expect(useModelSetupStore.getState().progress).toEqual({
      t: { transferred: 5, total: 10 },
    })
  })

  it('measures how fast each download comes, for the download panel', () => {
    vi.useFakeTimers()
    const { apply } = useModelSetupStore.getState()
    vi.setSystemTime(10_000)
    apply({ type: 'progress', taskId: 't', transferred: 0, total: 100 })
    vi.setSystemTime(11_000)
    apply({ type: 'progress', taskId: 't', transferred: 50, total: 100 })

    expect(useModelSetupStore.getState().speeds.t.bytesPerSecond).toBe(50)
  })

  it('forgets the verdicts when a new core generation attaches', () => {
    const store = useModelSetupStore.getState()
    store.setVerdict('u1', verdict)
    store.setVerdict('u2', null)
    expect(useModelSetupStore.getState().verdicts).toEqual({
      u1: verdict,
      u2: null,
    })

    store.apply({ type: 'changed', setup: setup('a', 1, 'queued') })
    store.apply({ type: 'reset' })
    expect(useModelSetupStore.getState().verdicts).toEqual({})
    expect(useModelSetupStore.getState().setups.a).toBeDefined()
  })

  it('replaces every setup with the core list', () => {
    const store = useModelSetupStore.getState()
    store.apply({ type: 'changed', setup: setup('gone', 1, 'queued') })
    store.replaceAll([setup('a', 1, 'ready'), setup('a', 3, 'failed')])
    const { setups } = useModelSetupStore.getState()
    expect(Object.keys(setups)).toEqual(['a'])
    expect(setups.a.stage).toBe('failed')
  })
})
