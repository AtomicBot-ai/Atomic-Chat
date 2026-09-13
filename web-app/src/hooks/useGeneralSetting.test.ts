import { describe, it, expect } from 'vitest'

import { localStorageKey } from '@/constants/localStorage'
import { useGeneralSetting } from './useGeneralSetting'

describe('useGeneralSetting persistence', () => {
  it('carries a stored uncapped thinking level onto the effort scale', async () => {
    localStorage.setItem(
      localStorageKey.settingGeneral,
      JSON.stringify({
        state: { reasoningBudget: 'unlimited', disableReasoning: false },
        version: 0,
      })
    )

    await useGeneralSetting.persist.rehydrate()

    expect(useGeneralSetting.getState().reasoningBudget).toBe('max')
    // The v1 -> v2 migration (upstream v2.0.37) switches reasoning off once for
    // every install saved before v2; __tests__/useGeneralSetting.migrate.test.ts
    // pins the same v0 case.
    expect(useGeneralSetting.getState().disableReasoning).toBe(true)
  })

  it('leaves a level that is already on the scale alone', async () => {
    localStorage.setItem(
      localStorageKey.settingGeneral,
      JSON.stringify({ state: { reasoningBudget: 'high' }, version: 1 })
    )

    await useGeneralSetting.persist.rehydrate()

    expect(useGeneralSetting.getState().reasoningBudget).toBe('high')
  })
})
