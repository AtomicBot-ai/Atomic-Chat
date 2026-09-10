import { beforeEach, describe, expect, it } from 'vitest'

import { localStorageKey } from '@/constants/localStorage'
import {
  runTurboquantDefaultMigration,
  turboquantDefaultActive,
} from '@/lib/turboquantDefaultMigration'

const FLAG_KEY = 'atomic_turboquant_default_active_v1'

beforeEach(() => {
  localStorage.clear()
})

describe('runTurboquantDefaultMigration', () => {
  it('classifies a fresh install as turboquant-disabled', () => {
    runTurboquantDefaultMigration()
    expect(localStorage.getItem(FLAG_KEY)).toBe('false')
    expect(turboquantDefaultActive()).toBe(false)
  })

  it('keeps turboquant active for a profile with a persisted model-provider blob', () => {
    // Windows profiles that went through zustand migration v13 have the blob
    // but no `llamacpp` entry inside it — the blob alone marks them existing.
    localStorage.setItem(localStorageKey.modelProvider, '{"state":{}}')
    runTurboquantDefaultMigration()
    expect(localStorage.getItem(FLAG_KEY)).toBe('true')
    expect(turboquantDefaultActive()).toBe(true)
  })

  it('keeps turboquant active for a profile that completed onboarding without a blob', () => {
    localStorage.setItem(localStorageKey.setupCompleted, 'true')
    runTurboquantDefaultMigration()
    expect(localStorage.getItem(FLAG_KEY)).toBe('true')
  })

  it('never overwrites an existing verdict on later launches', () => {
    runTurboquantDefaultMigration()
    expect(localStorage.getItem(FLAG_KEY)).toBe('false')
    // By the second launch the blob exists — the frozen verdict must win.
    localStorage.setItem(localStorageKey.modelProvider, '{"state":{}}')
    runTurboquantDefaultMigration()
    expect(localStorage.getItem(FLAG_KEY)).toBe('false')
  })
})

describe('turboquantDefaultActive', () => {
  it('falls back to active (pre-change behavior) when the flag is missing', () => {
    expect(turboquantDefaultActive()).toBe(true)
  })

  it('treats any non-false value as active', () => {
    localStorage.setItem(FLAG_KEY, 'garbled')
    expect(turboquantDefaultActive()).toBe(true)
  })

  it('is false only for an explicit false verdict', () => {
    localStorage.setItem(FLAG_KEY, 'false')
    expect(turboquantDefaultActive()).toBe(false)
  })
})
