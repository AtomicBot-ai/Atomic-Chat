import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockIPC } from '@tauri-apps/api/mocks'
import { TauriEventsService } from '../events/tauri'

describe('TauriEventsService', () => {
  let eventsService: TauriEventsService

  beforeEach(() => {
    mockIPC(() => undefined, { shouldMockEvents: true })
    eventsService = new TauriEventsService()
  })

  it('emits and listens through the Tauri event transport', async () => {
    const handler = vi.fn()
    await eventsService.listen<{ value: number }>('atomic-event', handler)

    await eventsService.emit('atomic-event', { value: 42 })

    expect(handler).toHaveBeenCalledWith({
      event: 'atomic-event',
      payload: { value: 42 },
    })
  })
})
