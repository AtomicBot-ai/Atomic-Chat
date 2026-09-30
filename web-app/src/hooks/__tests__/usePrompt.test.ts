import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { usePrompt } from '../usePrompt'

describe('usePrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    sessionStorage.clear()
    usePrompt.setState({ prompt: '' })
  })

  it('should initialize with empty prompt', () => {
    const { result } = renderHook(() => usePrompt())
    
    expect(result.current.prompt).toBe('')
    expect(typeof result.current.setPrompt).toBe('function')
  })

  it('should update prompt', () => {
    const { result } = renderHook(() => usePrompt())
    
    act(() => {
      result.current.setPrompt('Hello, world!')
    })
    
    expect(result.current.prompt).toBe('Hello, world!')
  })

  it('should clear prompt', () => {
    const { result } = renderHook(() => usePrompt())
    
    act(() => {
      result.current.setPrompt('Some text')
    })
    
    expect(result.current.prompt).toBe('Some text')
    
    act(() => {
      result.current.setPrompt('')
    })
    
    expect(result.current.prompt).toBe('')
  })

  it('should handle multiple prompt updates', () => {
    const { result } = renderHook(() => usePrompt())
    
    act(() => {
      result.current.setPrompt('First')
    })
    
    expect(result.current.prompt).toBe('First')
    
    act(() => {
      result.current.setPrompt('Second')
    })
    
    expect(result.current.prompt).toBe('Second')
    
    act(() => {
      result.current.setPrompt('Third')
    })
    
    expect(result.current.prompt).toBe('Third')
  })

  it('should handle special characters in prompt', () => {
    const { result } = renderHook(() => usePrompt())
    
    const specialText = 'Hello! @#$%^&*()_+{}|:"<>?[]\\;\',./'
    
    act(() => {
      result.current.setPrompt(specialText)
    })
    
    expect(result.current.prompt).toBe(specialText)
  })

  it('should handle multiline prompts', () => {
    const { result } = renderHook(() => usePrompt())
    
    const multilineText = 'Line 1\nLine 2\nLine 3'
    
    act(() => {
      result.current.setPrompt(multilineText)
    })
    
    expect(result.current.prompt).toBe(multilineText)
  })

  it('should handle very long prompts', () => {
    const { result } = renderHook(() => usePrompt())
    
    const longText = 'A'.repeat(10000)
    
    act(() => {
      result.current.setPrompt(longText)
    })
    
    expect(result.current.prompt).toBe(longText)
    expect(result.current.prompt.length).toBe(10000)
  })

  it('keeps a draft when the composer remounts in the same app session', () => {
    const firstMount = renderHook(() => usePrompt((state) => state.prompt))

    act(() => {
      usePrompt.getState().setPrompt('Keep this while I change routes')
    })
    firstMount.unmount()

    const secondMount = renderHook(() => usePrompt((state) => state.prompt))
    expect(secondMount.result.current).toBe(
      'Keep this while I change routes'
    )
  })

  it('starts empty in a fresh app session instead of rehydrating draft text', async () => {
    usePrompt.getState().setPrompt('Old in-memory draft')
    localStorage.setItem(
      'prompt',
      JSON.stringify({ state: { prompt: 'Old local draft' }, version: 1 })
    )
    sessionStorage.setItem('prompt', 'Old session draft')

    vi.resetModules()
    const { usePrompt: freshSessionPrompt } = await import('../usePrompt')

    expect(freshSessionPrompt.getState().prompt).toBe('')
  })
})
