import { describe, expect, it, vi } from 'vitest'
import { createSafeUnlisten } from '@/lib/tauriEvent'

describe('createSafeUnlisten', () => {
  it('detaches the listener only once', async () => {
    let detachments = 0
    const detach = createSafeUnlisten(() => {
      detachments += 1
    })

    await detach()
    await detach()

    expect(detachments).toBe(1)
  })

  it('swallows the teardown error Tauri raises for a stale listener', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const detach = createSafeUnlisten(() => {
      throw new TypeError(
        "undefined is not an object (evaluating 'listeners[eventId].handlerId')"
      )
    })

    await expect(detach()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()

    warn.mockRestore()
  })
})
