import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mockOnDragDropEvent = vi.fn()

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: mockOnDragDropEvent }),
}))

vi.mock('@/lib/platform/utils', () => ({
  isPlatformTauri: () => true,
}))

import { useTauriDragDrop } from '@/containers/chatInput/useTauriDragDrop'

const options = {
  enabled: true,
  onDragOver: vi.fn(),
  onDragLeave: vi.fn(),
  onDrop: vi.fn(),
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('useTauriDragDrop', () => {
  it('detaches a listener that resolves after unmount', async () => {
    let detachments = 0
    let resolveRegistration: (fn: () => void) => void = () => {}
    mockOnDragDropEvent.mockReturnValue(
      new Promise<() => void>((resolve) => {
        resolveRegistration = resolve
      })
    )

    const { unmount } = renderHook(() => useTauriDragDrop(options))
    unmount()
    resolveRegistration(() => {
      detachments += 1
    })

    await vi.waitFor(() => expect(detachments).toBe(1))
  })

  it('never detaches the same listener twice', async () => {
    let detachments = 0
    mockOnDragDropEvent.mockResolvedValue(() => {
      detachments += 1
    })

    const { unmount } = renderHook(() => useTauriDragDrop(options))
    await vi.waitFor(() => expect(mockOnDragDropEvent.mock.calls.length).toBe(1))
    unmount()
    unmount()

    await vi.waitFor(() => expect(detachments).toBe(1))
    expect(detachments).toBe(1)
  })
})
