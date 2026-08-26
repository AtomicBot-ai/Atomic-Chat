import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useApiServerLog } from '../useApiServerLog'

const { appState } = vi.hoisted(() => ({
  appState: { activeModels: [] as string[] },
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/hooks/useAppState', () => ({
  useAppState: (selector: (s: typeof appState) => unknown) => selector(appState),
}))

import { useApiServerModelNotices } from '../useApiServerModelNotices'

const store = () => useApiServerLog.getState()

describe('useApiServerModelNotices', () => {
  beforeEach(() => {
    store().reset()
    appState.activeModels = []
  })

  it('does not replay the models already loaded when the screen opens', () => {
    appState.activeModels = ['gemma-4']
    renderHook(() => useApiServerModelNotices())
    expect(store().entries).toEqual([])
  })

  it('adds a row when a model is loaded', () => {
    const { rerender } = renderHook(() => useApiServerModelNotices())
    appState.activeModels = ['gemma-4']
    rerender()
    expect(store().entries).toHaveLength(1)
    expect(store().entries[0]).toMatchObject({
      kind: 'event',
      title: 'api:notice.modelLoaded',
      detail: 'gemma-4',
    })
  })

  it('adds a row when a model is unloaded', () => {
    appState.activeModels = ['gemma-4']
    const { rerender } = renderHook(() => useApiServerModelNotices())
    appState.activeModels = []
    rerender()
    expect(store().entries[0]).toMatchObject({
      title: 'api:notice.modelUnloaded',
      detail: 'gemma-4',
    })
  })

  it('stays quiet when the model set is unchanged', () => {
    appState.activeModels = ['gemma-4']
    const { rerender } = renderHook(() => useApiServerModelNotices())
    rerender()
    expect(store().entries).toEqual([])
  })
})
