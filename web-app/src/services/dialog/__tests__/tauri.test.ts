import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/i18n/setup', () => ({ default: { t: (key: string) => key } }))

import { TauriDialogService } from '../tauri'

describe('TauriDialogService', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.toastError.mockReset()
  })

  it('says so when the picker failed to open, and still answers "nothing chosen"', async () => {
    mocks.invoke.mockRejectedValue('The system file dialog could not be opened')

    const service = new TauriDialogService()

    expect(await service.open({ directory: true })).toBeNull()
    expect(await service.save({})).toBeNull()
    expect(mocks.toastError).toHaveBeenCalledTimes(2)
    expect(mocks.toastError).toHaveBeenCalledWith(
      'common:toast.fileDialogFailed.title',
      expect.objectContaining({ id: 'file-dialog-failed' })
    )
  })

  it('stays quiet when the user cancels or chooses', async () => {
    const service = new TauriDialogService()

    mocks.invoke.mockResolvedValueOnce(null)
    expect(await service.open({ directory: true })).toBeNull()
    mocks.invoke.mockResolvedValueOnce('C:\\Work')
    expect(await service.open({ directory: true })).toBe('C:\\Work')

    expect(mocks.toastError).not.toHaveBeenCalled()
  })
})
