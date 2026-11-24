import { describe, expect, it } from 'vitest'

import i18n from '@/i18n/setup'
import {
  keepPending,
  requestDeviceName,
  requestsForCorner,
  takeNewRequests,
} from '@/lib/remoteRequestNotice'
import type { RemotePendingRequest } from '@/services/account/remote-types'

const request = (
  grantId: string,
  over: Partial<RemotePendingRequest> = {}
): RemotePendingRequest => ({
  grantId,
  deviceName: "Ann's iPhone",
  platform: 'ios',
  clientType: 'mobile',
  checkCode: '123456',
  createdAt: '2026-11-23T10:00:00Z',
  ...over,
})

describe('takeNewRequests', () => {
  it('gives each request once, by grant id, in order', () => {
    const announced = new Set<string>()

    const first = takeNewRequests([request('g1')], announced)
    const again = takeNewRequests([request('g1')], announced)
    const later = takeNewRequests(
      [request('g1'), request('g2'), request('g3')],
      announced
    )

    expect(first.map((r) => r.grantId)).toEqual(['g1'])
    expect(again).toEqual([])
    expect(later.map((r) => r.grantId)).toEqual(['g2', 'g3'])
  })

  it('counts a request already pending at start as new', () => {
    const announced = new Set<string>()

    const atStart = takeNewRequests([request('g1'), request('g2')], announced)

    expect(atStart.map((r) => r.grantId)).toEqual(['g1', 'g2'])
    expect([...announced]).toEqual(['g1', 'g2'])
  })
})

describe('requestsForCorner', () => {
  const pending = [request('g1'), request('g2')]

  it('lists the pending requests that were not put away or seen', () => {
    expect(
      requestsForCorner(pending, ['g1'], false).map((r) => r.grantId)
    ).toEqual(['g2'])
  })

  it('lists nothing on the Remote models page, which shows them itself', () => {
    expect(requestsForCorner(pending, [], true)).toEqual([])
  })

  it('lists nothing once every request is acknowledged', () => {
    expect(requestsForCorner(pending, ['g1', 'g2'], false)).toEqual([])
  })
})

describe('keepPending', () => {
  it('forgets requests that were allowed, denied or expired', () => {
    expect(keepPending(['g1', 'g2'], [request('g2'), request('g3')])).toEqual([
      'g2',
    ])
    expect(keepPending(['g1'], [])).toEqual([])
  })
})

describe('requestDeviceName', () => {
  it("uses the device's own name, trimmed", () => {
    expect(requestDeviceName(i18n.t, request('g1'))).toBe("Ann's iPhone")
    expect(
      requestDeviceName(i18n.t, request('g1', { deviceName: '  Pixel  ' }))
    ).toBe('Pixel')
  })

  it('falls back to the platform, then to an unknown device', () => {
    expect(
      requestDeviceName(
        i18n.t,
        request('g1', { deviceName: ' ', platform: 'ios' })
      )
    ).toBe('iOS device')
    expect(
      requestDeviceName(
        i18n.t,
        request('g1', { deviceName: null, platform: null })
      )
    ).toBe('Unknown device')
  })
})
