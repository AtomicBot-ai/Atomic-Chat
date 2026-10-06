import { beforeEach, describe, expect, it, vi } from 'vitest'

import { startManagedEnvironmentSync } from '../sync'
import { useManagedEnvironmentStore } from '@/stores/managed-environment-store'

type Handler = (event: { payload: unknown }) => void

function bus() {
  const handlers = new Map<string, Handler>()
  return {
    listen: vi.fn(async (name: string, handler: Handler) => {
      handlers.set(name, handler)
      return () => handlers.delete(name)
    }),
    emit(name: string, payload: unknown) {
      handlers.get(name)?.({ payload })
    },
    subscribed: () => [...handlers.keys()].sort(),
  }
}

const environment = (instance: string, revision: number, availability = 'setup-required') => ({
  schema_version: 1,
  environment_id: 'default',
  instance_id: instance,
  revision,
  executor: 'linux-docker',
  availability,
  gpus: [],
  blockers: [],
  selinux: null,
  installations: [],
  active_operation_id: null,
  minimum_app_version: null,
})

const coreSnapshot = (instance: string, revision: number, availability?: string) => ({
  instance_id: instance,
  environments: [environment(instance, revision, availability)],
  environment_operations: [],
})

const held = () => useManagedEnvironmentStore.getState()

beforeEach(() => held().reset())

describe('startManagedEnvironmentSync', () => {
  it('reads the snapshot, then follows the relayed events', async () => {
    const events = bus()
    const stop = await startManagedEnvironmentSync({
      listen: events.listen,
      readSnapshot: async () => coreSnapshot('core-a', 1),
    })

    expect(held().environments['default'].revision).toBe(1)
    events.emit('atomic-core://environment:changed', environment('core-a', 2, 'supported'))
    expect(held().environments['default'].availability).toBe('supported')
    expect(events.subscribed()).toEqual([
      'atomic-core://detached',
      'atomic-core://environment:changed',
      'atomic-core://environment:operation',
      'atomic-core://snapshot',
    ])

    stop()
    expect(events.subscribed()).toEqual([])
  })

  it('rebuilds from the snapshot the relay hands out on reattach, and stops trusting events on detach', async () => {
    const events = bus()
    await startManagedEnvironmentSync({
      listen: events.listen,
      readSnapshot: async () => coreSnapshot('core-a', 1),
    })

    events.emit('atomic-core://detached', {})
    events.emit('atomic-core://environment:changed', environment('core-a', 9, 'supported'))
    expect(held().environments['default'].availability).toBe('setup-required')

    // The relay's reattach event carries the core's snapshot under `snapshot`.
    events.emit('atomic-core://snapshot', { generation: 2, snapshot: coreSnapshot('core-b', 1, 'supported') })
    expect(held().instanceId).toBe('core-b')
    expect(held().environments['default'].availability).toBe('supported')
  })

  it('keeps following events when the first snapshot cannot be read', async () => {
    // The core may still be starting; the relay's own snapshot arrives once it attaches.
    const events = bus()
    await startManagedEnvironmentSync({
      listen: events.listen,
      readSnapshot: async () => {
        throw new Error('core not attached')
      },
    })

    events.emit('atomic-core://snapshot', { generation: 1, snapshot: coreSnapshot('core-a', 3) })
    expect(held().environments['default'].revision).toBe(3)
  })
})
