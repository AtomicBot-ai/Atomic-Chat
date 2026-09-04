import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useMCPServerStatuses } from '../useMCPServerStatuses'
import { SystemEvent } from '@/types/events'
import type { MCPServerStatus } from '@/services/mcp/types'

const getMCPServerStatuses = vi.fn()
const unlisten = vi.fn()
const handlers = new Map<string, () => void>()

// The hook subscribes through the service hub rather than
// `@tauri-apps/api/event`, so that the web platform gets a no-op and the
// detacher it hands back is already idempotent.
const listen = vi.fn(async (event: string, handler: () => void) => {
  handlers.set(event, handler)
  return unlisten
})

// The real hook reads a stable instance out of the service store, so the mock
// must return the same object on every render or the effect re-subscribes.
const serviceHubMock = {
  mcp: () => ({
    getMCPServerStatuses: (...args: unknown[]) => getMCPServerStatuses(...args),
  }),
  events: () => ({ listen }),
}

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => serviceHubMock,
}))

describe('useMCPServerStatuses', () => {
  beforeEach(() => {
    handlers.clear()
    unlisten.mockClear()
    listen.mockClear()
    getMCPServerStatuses.mockReset()
  })

  it('fetches statuses on mount and exposes a name map', async () => {
    const statuses: MCPServerStatus[] = [
      { name: 'exa', status: 'connected' },
      { name: 'bad', status: 'error', error: 'boom' },
    ]
    getMCPServerStatuses.mockResolvedValue(statuses)

    const { result } = renderHook(() => useMCPServerStatuses())

    await waitFor(() => expect(result.current.statuses).toEqual(statuses))
    expect(result.current.statusByName.get('exa')?.status).toBe('connected')
    expect(result.current.statusByName.get('bad')?.error).toBe('boom')
  })

  it('refreshes when MCP events fire', async () => {
    getMCPServerStatuses.mockResolvedValue([])
    const { result } = renderHook(() => useMCPServerStatuses())

    await waitFor(() =>
      expect(handlers.has(SystemEvent.MCP_STATUS_UPDATE)).toBe(true)
    )

    getMCPServerStatuses.mockResolvedValue([
      { name: 'fetch', status: 'connected' },
    ])
    act(() => handlers.get(SystemEvent.MCP_UPDATE)?.())

    await waitFor(() =>
      expect(result.current.statusByName.get('fetch')?.status).toBe('connected')
    )
  })

  it('detaches listeners on unmount', async () => {
    getMCPServerStatuses.mockResolvedValue([])
    const { unmount } = renderHook(() => useMCPServerStatuses())

    await waitFor(() => expect(handlers.size).toBe(2))
    unmount()

    await waitFor(() => expect(unlisten).toHaveBeenCalledTimes(2))
  })

  it('does not reject when the subscription fails', async () => {
    getMCPServerStatuses.mockResolvedValue([])
    listen.mockRejectedValueOnce(new Error('no Tauri bridge'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { result, unmount } = renderHook(() => useMCPServerStatuses())

    await waitFor(() => expect(warn).toHaveBeenCalled())
    expect(result.current.statuses).toEqual([])
    // Teardown must stay safe when setup never produced a detacher.
    expect(() => unmount()).not.toThrow()

    warn.mockRestore()
  })
})
