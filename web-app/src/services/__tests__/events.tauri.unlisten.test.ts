import { beforeEach, describe, expect, it, vi } from 'vitest'

// The official Tauri IPC mock swallows `plugin:event|unlisten` internally, so
// the detach path can only be observed by stubbing the event module itself.
const listen = vi.fn()
const emit = vi.fn()

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listen(...args),
  emit: (...args: unknown[]) => emit(...args),
}))

const { TauriEventsService } = await import('../events/tauri')

describe('TauriEventsService detach', () => {
  beforeEach(() => {
    listen.mockReset()
    emit.mockReset()
  })

  // Effect cleanups run twice under StrictMode, a fast unmount or an HMR
  // reload. Tauri's `_unlisten` throws on the second detach and the rejection
  // escapes unhandled, so the service hands callers a one-shot detach.
  it('detaches the underlying listener at most once', async () => {
    const unlisten = vi.fn()
    listen.mockResolvedValue(unlisten)

    const detach = await new TauriEventsService().listen('evt', () => {})
    await detach()
    await detach()

    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it('swallows the TypeError Tauri raises for a stale listener', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    listen.mockResolvedValue(() => {
      throw new TypeError(
        "undefined is not an object (evaluating 'listeners[eventId].handlerId')"
      )
    })

    const detach = await new TauriEventsService().listen('evt', () => {})

    await expect(detach()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()

    warn.mockRestore()
  })
})
