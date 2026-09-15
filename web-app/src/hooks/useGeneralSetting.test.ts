import { describe, it, expect } from 'vitest'

import { localStorageKey } from '@/constants/localStorage'
import { resetLegacyAgentModeProbe } from '@/lib/legacy-agent-mode'
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
    // v1 → v2 resets reasoning to off for every pre-2026-04-29 install — the
    // store saved every field, so those carried it on without anyone choosing
    // it. The chosen level above survives; the on/off switch does not.
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

  // v2 → v3: Agent mode moved from a per-thread flag to this global toggle,
  // which defaults to off. Without the carry-over, everyone who had been
  // running threads on the agent engine was silently dropped back onto the
  // chat pipeline — where agent skills never reach the model.
  it('turns Agent mode on for an install that had it on per thread', async () => {
    localStorage.setItem(
      localStorageKey.agentMode,
      JSON.stringify({ state: { agentThreads: { 'thread-1': true } }, version: 2 })
    )
    localStorage.setItem(
      localStorageKey.settingGeneral,
      JSON.stringify({ state: { agentModeEnabled: false }, version: 2 })
    )
    resetLegacyAgentModeProbe()

    await useGeneralSetting.persist.rehydrate()

    expect(useGeneralSetting.getState().agentModeEnabled).toBe(true)
  })

  it('leaves Agent mode off for an install that never used it', async () => {
    localStorage.setItem(
      localStorageKey.agentMode,
      JSON.stringify({ state: { agentThreads: {} }, version: 2 })
    )
    localStorage.setItem(
      localStorageKey.settingGeneral,
      JSON.stringify({ state: { agentModeEnabled: false }, version: 2 })
    )
    resetLegacyAgentModeProbe()

    await useGeneralSetting.persist.rehydrate()

    expect(useGeneralSetting.getState().agentModeEnabled).toBe(false)
  })
})
