import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  restoreFreshInstallBackup,
  runFreshInstallReset,
} from '@/lib/freshInstall'

const BACKUP_KEY = '__atomic_fresh_install_backup_v1__'
const SESSION_MARKER = 'atomic_fresh_install_launch'

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('runFreshInstallReset (FRESH_INSTALL builds)', () => {
  beforeEach(() => {
    vi.stubGlobal('FRESH_INSTALL', true)
  })

  it('backs up the profile and starts the launch with an empty localStorage', () => {
    localStorage.setItem('model-provider', '{"state":{}}')
    localStorage.setItem('setup-completed', 'true')

    runFreshInstallReset()

    expect(localStorage.getItem('model-provider')).toBeNull()
    expect(localStorage.getItem('setup-completed')).toBeNull()
    expect(JSON.parse(localStorage.getItem(BACKUP_KEY) ?? '{}')).toEqual({
      'model-provider': '{"state":{}}',
      'setup-completed': 'true',
    })
    expect(sessionStorage.getItem(SESSION_MARKER)).toBe('true')
  })

  it('wipes once per launch, not on reloads within the same launch', () => {
    runFreshInstallReset()
    // A reload keeps sessionStorage; mid-flow progress must survive it.
    localStorage.setItem('setup-completed', 'true')

    runFreshInstallReset()

    expect(localStorage.getItem('setup-completed')).toBe('true')
  })

  it('keeps the original backup across fresh launches, discarding fresh-run residue', () => {
    localStorage.setItem('model-provider', 'original-profile')
    runFreshInstallReset()

    // Next app launch (sessionStorage gone), fresh-run data present.
    sessionStorage.clear()
    localStorage.setItem('model-provider', 'fresh-run-data')
    runFreshInstallReset()

    expect(localStorage.getItem('model-provider')).toBeNull()
    expect(JSON.parse(localStorage.getItem(BACKUP_KEY) ?? '{}')).toEqual({
      'model-provider': 'original-profile',
    })
  })

  it('never restores the backup mid-fresh-mode', () => {
    localStorage.setItem('model-provider', 'original-profile')
    runFreshInstallReset()

    restoreFreshInstallBackup()

    expect(localStorage.getItem('model-provider')).toBeNull()
    expect(localStorage.getItem(BACKUP_KEY)).not.toBeNull()
  })
})

describe('restoreFreshInstallBackup (normal builds)', () => {
  it('puts the original profile back and drops the backup and fresh-run keys', () => {
    localStorage.setItem(
      BACKUP_KEY,
      JSON.stringify({ 'model-provider': 'original-profile' })
    )
    localStorage.setItem('atomic_turboquant_default_active_v1', 'false')

    restoreFreshInstallBackup()

    expect(localStorage.getItem('model-provider')).toBe('original-profile')
    expect(localStorage.getItem(BACKUP_KEY)).toBeNull()
    expect(
      localStorage.getItem('atomic_turboquant_default_active_v1')
    ).toBeNull()
  })

  it('is a no-op when no backup exists', () => {
    localStorage.setItem('model-provider', 'untouched')

    restoreFreshInstallBackup()

    expect(localStorage.getItem('model-provider')).toBe('untouched')
  })
})

describe('shipped builds (flag undefined)', () => {
  it('reset is a no-op', () => {
    localStorage.setItem('model-provider', 'untouched')

    runFreshInstallReset()

    expect(localStorage.getItem('model-provider')).toBe('untouched')
    expect(localStorage.getItem(BACKUP_KEY)).toBeNull()
  })
})
