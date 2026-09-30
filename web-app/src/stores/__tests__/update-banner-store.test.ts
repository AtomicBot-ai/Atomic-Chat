import { describe, expect, it } from 'vitest'

import { activeUpdateBannerSlot } from '@/stores/update-banner-store'

const claims = (...slots: ('download' | 'app' | 'engine')[]) => ({
  download: slots.includes('download'),
  app: slots.includes('app'),
  engine: slots.includes('engine'),
})

describe('activeUpdateBannerSlot', () => {
  it('is empty when nobody wants the corner', () => {
    expect(activeUpdateBannerSlot(claims())).toBeNull()
  })

  it('gives a lone claimant the corner', () => {
    expect(activeUpdateBannerSlot(claims('engine'))).toBe('engine')
    expect(activeUpdateBannerSlot(claims('app'))).toBe('app')
  })

  it('never stacks the app and engine offers (ATO-533)', () => {
    expect(activeUpdateBannerSlot(claims('app', 'engine'))).toBe('app')
  })

  it('lets a running transfer outrank both offers', () => {
    expect(activeUpdateBannerSlot(claims('download', 'app', 'engine'))).toBe(
      'download'
    )
    expect(activeUpdateBannerSlot(claims('download', 'engine'))).toBe(
      'download'
    )
  })
})
