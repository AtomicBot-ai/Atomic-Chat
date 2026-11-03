import { beforeEach, describe, expect, it, vi } from 'vitest'

import { restoreInstallDistinctId } from '@/lib/telemetry-identity'
import { DefaultAnalyticService } from '@/services/analytic/default'

// A posthog that keeps its id the way the real one does in localStorage:
// `identify` moves it, and a wiped storage comes back with a new one.
const fakePosthog = vi.hoisted(() => {
  let distinctId = ''
  return {
    startWithStorage(id: string) {
      distinctId = id
    },
    get_distinct_id: () => distinctId,
    identify: vi.fn((id: string) => {
      distinctId = id
    }),
  }
})

vi.mock('posthog-js', () => ({ default: fakePosthog }))

// settings.json behind the Tauri bridge: every read is a fresh copy, every
// write replaces the whole file.
let settingsJson: Record<string, unknown> | null
const getAppConfigurations = vi.fn(async () =>
  settingsJson ? { ...settingsJson } : null
)
Object.defineProperty(window, 'core', {
  writable: true,
  value: {
    api: {
      getAppConfigurations,
      updateAppConfiguration: async ({
        configuration,
      }: {
        configuration: Record<string, unknown>
      }) => {
        settingsJson = { ...configuration }
      },
    },
  },
})

const launch = () => restoreInstallDistinctId(new DefaultAnalyticService())

beforeEach(() => {
  fakePosthog.identify.mockClear()
  getAppConfigurations.mockClear()
  settingsJson = { data_folder: '/data', autostart_preference: 'disabled' }
})

describe('restoreInstallDistinctId', () => {
  it("stores posthog's own id on the first launch, beside the other settings", async () => {
    fakePosthog.startWithStorage('anon-first')

    await launch()

    expect(settingsJson).toEqual({
      data_folder: '/data',
      autostart_preference: 'disabled',
      distinct_id: 'anon-first',
    })
    expect(fakePosthog.get_distinct_id()).toBe('anon-first')
    expect(fakePosthog.identify).not.toHaveBeenCalled()
  })

  it('puts posthog back on the stored id after its storage was wiped', async () => {
    fakePosthog.startWithStorage('anon-first')
    await launch()

    // A factory reset clears localStorage; posthog makes up a new id.
    fakePosthog.startWithStorage('anon-after-reset')
    await launch()

    expect(fakePosthog.get_distinct_id()).toBe('anon-first')
    expect(settingsJson?.distinct_id).toBe('anon-first')
  })

  it('leaves posthog alone when it already runs on the stored id', async () => {
    settingsJson = { data_folder: '/data', distinct_id: 'anon-first' }
    fakePosthog.startWithStorage('anon-first')

    await launch()

    expect(fakePosthog.identify).not.toHaveBeenCalled()
    expect(fakePosthog.get_distinct_id()).toBe('anon-first')
    expect(settingsJson).toEqual({
      data_folder: '/data',
      distinct_id: 'anon-first',
    })
  })

  it('stores nothing and keeps posthog on its id without the Tauri bridge', async () => {
    settingsJson = null
    fakePosthog.startWithStorage('anon-web')

    await launch()

    expect(settingsJson).toBeNull()
    expect(fakePosthog.get_distinct_id()).toBe('anon-web')
  })

  it('rejects when the settings cannot be read, so the caller can still opt in', async () => {
    getAppConfigurations.mockRejectedValueOnce(new Error('bridge down'))
    fakePosthog.startWithStorage('anon-first')

    await expect(launch()).rejects.toThrow('bridge down')
    expect(fakePosthog.get_distinct_id()).toBe('anon-first')
    expect(settingsJson).not.toHaveProperty('distinct_id')
  })
})
