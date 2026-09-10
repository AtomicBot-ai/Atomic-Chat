import { describe, it, expect, afterEach } from 'vitest'
import { isPlatformTauri, getCurrentPlatform } from './utils'

const bridge = () => window as unknown as Record<string, unknown>
const original = bridge().__TAURI_INTERNALS__

afterEach(() => {
  bridge().__TAURI_INTERNALS__ = original
})

describe('isPlatformTauri', () => {
  it('is true while the Tauri IPC bridge is present', () => {
    bridge().__TAURI_INTERNALS__ = {}

    expect(isPlatformTauri()).toBe(true)
    expect(getCurrentPlatform()).toBe('tauri')
  })

  it('is false without the bridge, even in a desktop bundle', () => {
    // The desktop bundle is served verbatim at http://localhost:1420 by
    // `tauri dev`; opening that in a browser leaves every build-time define
    // saying "desktop" while `invoke` and `listen` are unavailable.
    delete bridge().__TAURI_INTERNALS__

    expect(isPlatformTauri()).toBe(false)
    expect(getCurrentPlatform()).toBe('web')
  })
})
