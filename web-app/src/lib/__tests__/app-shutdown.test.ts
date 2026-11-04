import { beforeEach, describe, expect, it, vi } from 'vitest'

const listeners = vi.hoisted(() => new Map<string, () => void>())
const listen = vi.hoisted(() =>
  vi.fn(async (event: string, handler: () => void) => {
    listeners.set(event, handler)
    return () => listeners.delete(event)
  })
)
vi.mock('@tauri-apps/api/event', () => ({ listen }))
vi.mock('@/lib/platform/utils', () => ({ isPlatformTauri: () => true }))

import {
  APP_SHUTTING_DOWN_EVENT,
  isAppShuttingDown,
  resetAppShutdownForTests,
  watchAppShutdown,
} from '@/lib/app-shutdown'

describe('app shutdown', () => {
  beforeEach(() => {
    listeners.clear()
    listen.mockClear()
    resetAppShutdownForTests()
  })

  it('turns on, for good, when the shell announces the quit', () => {
    watchAppShutdown()
    expect(isAppShuttingDown()).toBe(false)

    listeners.get(APP_SHUTTING_DOWN_EVENT)!()
    expect(isAppShuttingDown()).toBe(true)
  })

  it('listens once however many composers ask', () => {
    watchAppShutdown()
    watchAppShutdown()
    expect(listen).toHaveBeenCalledTimes(1)
    expect(listen).toHaveBeenCalledWith(
      'app-shutting-down',
      expect.any(Function)
    )
    expect([...listeners.keys()]).toEqual([APP_SHUTTING_DOWN_EVENT])
  })

  it('tries again later when the listener could not be set up', async () => {
    listen.mockRejectedValueOnce(new Error('no IPC'))
    watchAppShutdown()
    await Promise.resolve()
    await Promise.resolve()
    watchAppShutdown()
    expect(listen).toHaveBeenCalledTimes(2)
    // The second attempt took: the quit is seen.
    await Promise.resolve()
    listeners.get(APP_SHUTTING_DOWN_EVENT)!()
    expect(isAppShuttingDown()).toBe(true)
  })
})
