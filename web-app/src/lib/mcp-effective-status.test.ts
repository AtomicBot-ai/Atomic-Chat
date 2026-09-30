import { describe, expect, it } from 'vitest'

import { effectiveMcpStatus } from './mcp-effective-status'

describe('effectiveMcpStatus', () => {
  const error = {
    name: 'exa',
    status: 'error' as const,
    error: 'HTTP 403 Forbidden',
  }

  it('reports bundled Exa as connected when its fallback tool is usable', () => {
    expect(
      effectiveMcpStatus('exa', error, [
        { server: 'exa', name: 'web_search_exa' } as never,
      ])
    ).toEqual({ name: 'exa', status: 'connected' })
  })

  it('keeps the real error when no fallback tool exists', () => {
    expect(effectiveMcpStatus('exa', error, [])).toBe(error)
  })

  it('does not mask errors from custom servers', () => {
    expect(
      effectiveMcpStatus('custom', { ...error, name: 'custom' }, [
        { server: 'custom', name: 'web_search_exa' } as never,
      ])
    ).toEqual({ ...error, name: 'custom' })
  })
})
