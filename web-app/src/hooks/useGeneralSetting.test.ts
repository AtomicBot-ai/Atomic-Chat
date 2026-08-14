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
    expect(useGeneralSetting.getState().disableReasoning).toBe(false)
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
