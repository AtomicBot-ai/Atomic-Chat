import { beforeEach, describe, expect, it } from 'vitest'
import { localStorageKey } from '@/constants/localStorage'
import {
  captureLegacyAgentThreads,
  hadLegacyPerThreadAgentMode,
  resetLegacyAgentModeProbe,
} from '@/lib/legacy-agent-mode'

const writeLegacyStore = (agentThreads: unknown) =>
  localStorage.setItem(
    localStorageKey.agentMode,
    JSON.stringify({ state: { agentThreads }, version: 2 })
  )

describe('legacy per-thread Agent mode probe', () => {
  beforeEach(() => {
    localStorage.clear()
    resetLegacyAgentModeProbe()
  })

  it('reports nothing to migrate on a clean install', () => {
    expect(hadLegacyPerThreadAgentMode()).toBe(false)
  })

  it('detects a thread that had Agent mode on', () => {
    writeLegacyStore({ 'thread-1': false, 'thread-2': true })
    resetLegacyAgentModeProbe()
    expect(hadLegacyPerThreadAgentMode()).toBe(true)
  })

  it('does not fire when every thread was on the chat pipeline', () => {
    writeLegacyStore({ 'thread-1': false, 'thread-2': false })
    resetLegacyAgentModeProbe()
    expect(hadLegacyPerThreadAgentMode()).toBe(false)
  })

  it('survives a corrupt or absent legacy store', () => {
    localStorage.setItem(localStorageKey.agentMode, 'not json')
    resetLegacyAgentModeProbe()
    expect(hadLegacyPerThreadAgentMode()).toBe(false)
  })

  // The `agent-mode` store deletes `agentThreads` in its own v3 migration.
  // When it hydrates first, the raw probe finds nothing — so that migration
  // hands the flags over directly.
  it('accepts the flags handed over by the agent-mode migration', () => {
    expect(hadLegacyPerThreadAgentMode()).toBe(false)
    captureLegacyAgentThreads({ 'thread-1': true })
    expect(hadLegacyPerThreadAgentMode()).toBe(true)
  })

  it('ignores a handover with nothing enabled', () => {
    captureLegacyAgentThreads({ 'thread-1': false })
    captureLegacyAgentThreads(undefined)
    expect(hadLegacyPerThreadAgentMode()).toBe(false)
  })
})
