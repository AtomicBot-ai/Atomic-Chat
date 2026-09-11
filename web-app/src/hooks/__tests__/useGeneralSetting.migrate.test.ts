import { describe, it, expect, beforeEach } from 'vitest'

import { localStorageKey } from '@/constants/localStorage'
import { useGeneralSetting } from '../useGeneralSetting'

/**
 * The persisted settings as the store finds them on launch. The sibling
 * `useGeneralSetting.test.ts` stubs out `persist`, so migrations are exercised
 * here against the real middleware and localStorage.
 */
const persisted = (state: Record<string, unknown>, version: number) =>
  localStorage.setItem(
    localStorageKey.settingGeneral,
    JSON.stringify({ state, version })
  )

describe('useGeneralSetting — persisted state migration', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('switches reasoning off once for installs saved before v2, keeping the level', async () => {
    // Installs from before 2026-04-29 saved reasoning on as the old default.
    persisted({ disableReasoning: false, reasoningBudget: 'high' }, 1)

    await useGeneralSetting.persist.rehydrate()

    expect(useGeneralSetting.getState().disableReasoning).toBe(true)
    expect(useGeneralSetting.getState().reasoningBudget).toBe('high')
  })

  it('keeps reasoning on when it was turned on after the reset', async () => {
    persisted({ disableReasoning: false, reasoningBudget: 'low' }, 2)

    await useGeneralSetting.persist.rehydrate()

    expect(useGeneralSetting.getState().disableReasoning).toBe(false)
  })

  it('still maps the old uncapped level onto max', async () => {
    persisted({ disableReasoning: false, reasoningBudget: 'unlimited' }, 0)

    await useGeneralSetting.persist.rehydrate()

    expect(useGeneralSetting.getState().reasoningBudget).toBe('max')
    expect(useGeneralSetting.getState().disableReasoning).toBe(true)
  })
})
