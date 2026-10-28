import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { localStorageKey } from '@/constants/localStorage'
import { useEmailReminderSync } from '@/hooks/useEmailReminderSync'
import { useModelProvider } from '@/hooks/useModelProvider'
import { EmailReminderError } from '@/services/email-reminders'
import {
  readEmailReminder,
  requestEmailReminder,
  syncEmailReminder,
  useEmailReminderStore,
} from '../email-reminder-store'

const api = vi.hoisted(() => ({ register: vi.fn(), notify: vi.fn() }))
vi.mock('@/services/email-reminders', async (original) => ({
  ...(await original<typeof import('@/services/email-reminders')>()),
  registerEmailReminder: api.register,
  notifyEmailReminder: api.notify,
}))

const model = {
  provider: 'llamacpp-upstream',
  matchIds: ['qwen-4b'],
  title: 'Qwen 4B',
}
const ready = [{ provider: model.provider, models: [{ id: 'qwen-4b' }] }]
const register = () =>
  requestEmailReminder(' user@example.com ', 'ru-RU', model)
const stored = () =>
  JSON.parse(localStorage.getItem(localStorageKey.emailReminder)!)

describe('model-ready email delivery', () => {
  beforeEach(() => {
    localStorage.clear()
    useEmailReminderStore.setState(readEmailReminder())
    useModelProvider.setState({ providers: [] })
    api.register.mockReset().mockResolvedValue(undefined)
    api.notify.mockReset().mockResolvedValue(undefined)
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('keeps one secure token across relaunch and email correction, without persisting the address', async () => {
    await register()
    const token = stored().token
    expect(token).toMatch(/^[a-f0-9]{64}$/)
    expect(api.register).toHaveBeenCalledWith(
      token,
      expect.objectContaining({
        email: 'user@example.com',
        locale: 'ru',
        model_name: 'Qwen 4B',
      })
    )
    expect(JSON.stringify(stored())).not.toContain('example.com')
    useEmailReminderStore.setState(readEmailReminder())
    await requestEmailReminder('fixed@example.com', 'de', model)
    expect(api.register).toHaveBeenLastCalledWith(
      token,
      expect.objectContaining({
        email: 'fixed@example.com',
        locale: 'en',
      })
    )
    expect(stored().token).toBe(token)
  })

  it('does not promise success or contact the API if persistence fails', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    await expect(register()).rejects.toThrow('quota')
    expect(api.register).not.toHaveBeenCalled()
    expect(useEmailReminderStore.getState().reminder).toBeNull()
  })

  it('leaves no active reminder after a failed registration and reuses the token on explicit retry', async () => {
    api.register.mockRejectedValueOnce(new TypeError('offline'))
    await expect(register()).rejects.toThrow('offline')
    const token = stored().token
    await syncEmailReminder(ready)
    expect(api.notify).not.toHaveBeenCalled()
    await register()
    expect(stored().token).toBe(token)
    expect(stored().reminder.status).toBe('waiting')
  })

  it('waits for the registered model and notifies only once across concurrent callers and relaunch', async () => {
    await register()
    await syncEmailReminder([
      { provider: model.provider, models: [{ id: 'different' }] },
    ])
    await syncEmailReminder([
      { provider: 'other', models: [{ id: 'qwen-4b' }] },
    ])
    expect(api.notify).not.toHaveBeenCalled()
    await Promise.all([syncEmailReminder(ready), syncEmailReminder(ready)])
    expect(api.notify).toHaveBeenCalledExactlyOnceWith(
      stored().token,
      'Qwen 4B'
    )
    useEmailReminderStore.setState(readEmailReminder())
    await syncEmailReminder(ready)
    expect(api.notify).toHaveBeenCalledTimes(1)
    expect(stored().reminder.status).toBe('queued')
  })

  it('retries a lost notify response after relaunch, keeping readiness and avoiding another PUT', async () => {
    await register()
    api.notify.mockRejectedValueOnce(new TypeError('offline'))
    await syncEmailReminder(ready)
    expect(stored().reminder.ready).toBe(true)
    useEmailReminderStore.setState(readEmailReminder())
    await syncEmailReminder([])
    expect(api.notify).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(120_000)
    await syncEmailReminder([])
    expect(api.notify).toHaveBeenCalledTimes(2)
    expect(api.register).toHaveBeenCalledTimes(1)
    expect(stored().reminder.status).toBe('queued')
  })

  it('stops on a replaced token instead of stealing the email back from another installation', async () => {
    await register()
    api.notify.mockRejectedValueOnce(new EmailReminderError(404))
    await syncEmailReminder(ready)
    vi.advanceTimersByTime(3_600_000)
    await syncEmailReminder(ready)
    expect(api.notify).toHaveBeenCalledTimes(1)
    expect(api.register).toHaveBeenCalledTimes(1)
    expect(stored().reminder.status).toBe('expired')
  })

  it('honors Retry-After and retries server failures, while a rejected token is terminal', async () => {
    await register()
    api.notify.mockRejectedValueOnce(new EmailReminderError(429, 3_600_000))
    await syncEmailReminder(ready)
    vi.advanceTimersByTime(120_000)
    await syncEmailReminder(ready)
    expect(api.notify).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(3_600_000)
    api.notify.mockRejectedValueOnce(new EmailReminderError(503))
    await syncEmailReminder(ready)
    expect(stored().reminder.status).toBe('waiting')
    vi.advanceTimersByTime(3_600_000)
    api.notify.mockRejectedValueOnce(new EmailReminderError(401))
    await syncEmailReminder(ready)
    expect(stored().reminder.status).toBe('failed')
  })

  it('expires an old intent without sending or re-registering', async () => {
    await register()
    vi.advanceTimersByTime(30 * 24 * 60 * 60 * 1000)
    await syncEmailReminder(ready)
    expect(api.notify).not.toHaveBeenCalled()
    expect(stored().reminder.status).toBe('expired')
  })

  it('serializes an email correction behind an in-flight notification', async () => {
    await register()
    let finish!: () => void
    api.notify.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const notifying = syncEmailReminder(ready)
    await vi.waitFor(() => expect(api.notify).toHaveBeenCalledTimes(1))
    const correcting = requestEmailReminder('fixed@example.com', 'en', model)
    expect(api.register).toHaveBeenCalledTimes(1)
    finish()
    await Promise.all([notifying, correcting])
    expect(api.register).toHaveBeenCalledTimes(2)
    expect(stored().reminder.status).toBe('waiting')
  })

  it('reports readiness without the wait screen, including a model completing during registration', async () => {
    let finish!: () => void
    api.register.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    renderHook(() => useEmailReminderSync())
    const registration = register()
    await vi.waitFor(() => expect(api.register).toHaveBeenCalledTimes(1))
    await act(async () => {
      useModelProvider.setState({ providers: ready } as never)
      finish()
      await registration
    })
    await act(async () => {
      await syncEmailReminder(ready)
    })
    expect(api.notify).toHaveBeenCalledTimes(1)
    expect(stored().reminder.status).toBe('queued')
  })

  it('ignores corrupt saved state', () => {
    localStorage.setItem(localStorageKey.emailReminder, '{broken')
    expect(readEmailReminder()).toEqual({ token: null, reminder: null })
    localStorage.setItem(
      localStorageKey.emailReminder,
      JSON.stringify({ token: 'x'.repeat(64), reminder: { provider: 'test' } })
    )
    expect(readEmailReminder()).toEqual({
      token: 'x'.repeat(64),
      reminder: null,
    })
  })
})
