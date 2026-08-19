import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useIsMobile } from '../use-mobile'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('useIsMobile', () => {
  it('returns false on a wide screen', () => {
    Object.defineProperty(window, 'innerWidth', { value: 1024, writable: true })
    const mql = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }
    vi.spyOn(window, 'matchMedia').mockReturnValue(mql as any)

    const { result } = renderHook(() => useIsMobile())
    expect(result.current).toBe(false)
  })

  it('returns true on a narrow screen', () => {
    Object.defineProperty(window, 'innerWidth', { value: 400, writable: true })
    const mql = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }
    vi.spyOn(window, 'matchMedia').mockReturnValue(mql as any)

    const { result } = renderHook(() => useIsMobile())
    expect(result.current).toBe(true)
  })

  it('falls back to deprecated addListener on older browsers that lack addEventListener on MediaQueryList', () => {
    const consoleWarnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => {})

    const mql = {
      addEventListener: vi.fn(() => {
        throw new Error('addEventListener not supported on MediaQueryList')
      }),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }
    vi.spyOn(window, 'matchMedia').mockReturnValue(mql as any)
    Object.defineProperty(window, 'innerWidth', { value: 1024, writable: true })

    renderHook(() => useIsMobile())

    expect(mql.addListener).toHaveBeenCalledWith(expect.any(Function))
    consoleWarnSpy.mockRestore()
  })

  it('removes the deprecated listener on unmount in older browsers', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const mql = {
      addEventListener: vi.fn(() => {
        throw new Error('addEventListener not supported')
      }),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }
    vi.spyOn(window, 'matchMedia').mockReturnValue(mql as any)
    Object.defineProperty(window, 'innerWidth', { value: 1024, writable: true })

    const { unmount } = renderHook(() => useIsMobile())
    unmount()

    expect(mql.removeListener).toHaveBeenCalledWith(expect.any(Function))
  })
})
