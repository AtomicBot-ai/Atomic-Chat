import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SystemEvent } from '@/types/events'
import type { EventsService } from '@/services/events/types'
import type { MCPService } from '@/services/mcp/types'
import type { RAGService } from '@/services/rag/types'
import { seedServiceHub } from '@/test/service-hub'

// Mock functions
const mockGetTools = vi.fn()
const mockUpdateTools = vi.fn()
const mockUpdateMcpToolNames = vi.fn()
const mockUpdateRagToolNames = vi.fn()
const mockListen = vi.fn()
const mockUnsubscribe = vi.fn()

// Mock useAppState
vi.mock('../useAppState', () => ({
  useAppState: (selector: any) =>
    selector({
      updateTools: mockUpdateTools,
      updateMcpToolNames: mockUpdateMcpToolNames,
      updateRagToolNames: mockUpdateRagToolNames,
    }),
}))

describe('useTools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seedServiceHub({
      mcp: {
        getToolsWithStatus: mockGetTools,
      } as MCPService,
      rag: {
        getToolNames: vi.fn(() => Promise.resolve([])),
      } as RAGService,
      events: {
        listen: mockListen,
      } as EventsService,
    })
    mockListen.mockResolvedValue(mockUnsubscribe)
    mockGetTools.mockResolvedValue({ tools: [], servers: [] })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should call getTools and updateTools on mount', async () => {
    const { useTools } = await import('../useTools')

    const mockTools = [
      { name: 'test-tool', description: 'A test tool' },
      { name: 'another-tool', description: 'Another test tool' },
    ]
    mockGetTools.mockResolvedValue({ tools: mockTools, servers: [] })

    renderHook(() => useTools())

    // Wait for async operations to complete
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(mockGetTools).toHaveBeenCalledTimes(1)
    expect(mockUpdateTools).toHaveBeenCalledWith(mockTools)
  })

  it('should set up event listener for MCP_UPDATE', async () => {
    const { useTools } = await import('../useTools')

    renderHook(() => useTools())

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(mockListen).toHaveBeenCalledWith(
      SystemEvent.MCP_UPDATE,
      expect.any(Function)
    )
  })

  it('should call setTools when MCP_UPDATE event is triggered', async () => {
    const { useTools } = await import('../useTools')

    const mockTools = [{ name: 'updated-tool', description: 'Updated tool' }]
    mockGetTools.mockResolvedValue({ tools: mockTools, servers: [] })

    let eventCallback: () => void

    mockListen.mockImplementation((_event, callback) => {
      eventCallback = callback
      return Promise.resolve(mockUnsubscribe)
    })

    renderHook(() => useTools())

    // Wait for initial setup
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    // Clear the initial calls
    vi.clearAllMocks()
    mockGetTools.mockResolvedValue({ tools: mockTools, servers: [] })

    // Trigger the event
    await act(async () => {
      eventCallback()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(mockGetTools).toHaveBeenCalledTimes(1)
    expect(mockUpdateTools).toHaveBeenCalledWith(mockTools)
  })

  it('should return unsubscribe function for cleanup', async () => {
    const { useTools } = await import('../useTools')

    const { unmount } = renderHook(() => useTools())

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(mockListen).toHaveBeenCalled()

    // Unmount should call the unsubscribe function
    unmount()

    expect(mockUnsubscribe).toHaveBeenCalledTimes(1)
    expect(mockListen).toHaveBeenCalledWith(
      SystemEvent.MCP_UPDATE,
      expect.any(Function)
    )
  })

  it('should handle getTools errors gracefully', async () => {
    const { useTools } = await import('../useTools')

    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {})
    mockGetTools.mockRejectedValue(new Error('Failed to get tools'))

    renderHook(() => useTools())

    await act(async () => {
      // Give enough time for the promise to be handled
      await new Promise((resolve) => setTimeout(resolve, 100))
    })

    expect(mockGetTools).toHaveBeenCalledTimes(1)
    // updateTools should not be called if getTools fails
    expect(mockUpdateTools).not.toHaveBeenCalled()

    consoleErrorSpy.mockRestore()
  })

  it('should handle event listener setup errors gracefully', async () => {
    const { useTools } = await import('../useTools')

    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {})
    mockListen.mockRejectedValue(new Error('Failed to set up listener'))

    renderHook(() => useTools())

    await act(async () => {
      // Give enough time for the promise to be handled
      await new Promise((resolve) => setTimeout(resolve, 100))
    })

    // Initial getTools should still work
    expect(mockGetTools).toHaveBeenCalledTimes(1)
    expect(mockListen).toHaveBeenCalled()

    consoleErrorSpy.mockRestore()
  })

  it('should only set up effect once with empty dependency array', async () => {
    const { useTools } = await import('../useTools')

    const { rerender } = renderHook(() => useTools())

    // Initial render
    expect(mockGetTools).toHaveBeenCalledTimes(1)
    expect(mockListen).toHaveBeenCalledTimes(1)

    // Rerender should not trigger additional calls
    rerender()
    expect(mockGetTools).toHaveBeenCalledTimes(1)
    expect(mockListen).toHaveBeenCalledTimes(1)
  })

  it('deduplicates concurrent tool requests and shares one listener', async () => {
    const { useTools } = await import('../useTools')
    const first = renderHook(() => useTools())
    const second = renderHook(() => useTools())

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(mockGetTools).toHaveBeenCalledTimes(1)
    expect(mockListen).toHaveBeenCalledTimes(1)

    first.unmount()
    expect(mockUnsubscribe).not.toHaveBeenCalled()

    second.unmount()
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1)
  })

  it('queues every update that arrives during discovery', async () => {
    const { useTools } = await import('../useTools')
    let resolveInitial: ((value: unknown) => void) | undefined
    let resolveQueued: ((value: unknown) => void) | undefined
    let eventCallback: (() => void) | undefined
    const initialResponse = new Promise((resolve) => {
      resolveInitial = resolve
    })
    const queuedResponse = new Promise((resolve) => {
      resolveQueued = resolve
    })
    const refreshedTools = [{ name: 'fresh-tool', description: 'Fresh tool' }]

    mockGetTools
      .mockReturnValueOnce(initialResponse)
      .mockReturnValueOnce(queuedResponse)
      .mockResolvedValueOnce({ tools: refreshedTools, servers: [] })
    mockListen.mockImplementation((_event, callback) => {
      eventCallback = callback
      return Promise.resolve(mockUnsubscribe)
    })

    renderHook(() => useTools())
    await act(async () => {
      eventCallback?.()
      resolveInitial?.({ tools: [], servers: [] })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(mockGetTools).toHaveBeenCalledTimes(2)

    await act(async () => {
      eventCallback?.()
      resolveQueued?.({ tools: [], servers: [] })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(mockGetTools).toHaveBeenCalledTimes(3)
    expect(mockUpdateTools).toHaveBeenLastCalledWith(refreshedTools)
  })
})
