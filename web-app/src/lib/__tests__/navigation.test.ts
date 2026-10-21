import { describe, expect, it } from 'vitest'
import { isPathActive, navigationSection, normalizePath } from '../navigation'

describe('navigationSection', () => {
  it.each([
    ['/', 'chat'],
    ['/threads/abc', 'chat'],
    ['/project/p1', 'chat'],
    ['/images/', 'chat'],
    ['/videos/', 'chat'],
    ['/api/', 'server'],
    ['/launch/', 'server'],
    ['/settings/https-proxy', 'server'],
    ['/settings/local-api-server', 'server'],
    ['/settings/remote-lan', 'server'],
    ['/settings/claude-code', 'server'],
    ['/settings/hermes-agent', 'server'],
    ['/hub/', 'models'],
    ['/hub', 'models'],
    ['/downloads', 'models'],
    ['/cloud/', 'models'],
    ['/endpoints/', 'models'],
    ['/settings/providers', 'models'],
    ['/settings/providers/llamacpp-upstream', 'models'],
    ['/settings/media', 'models'],
    ['/settings/voice', 'models'],
    ['/settings/general', 'settings'],
    ['/settings/hardware', 'settings'],
    ['/settings/assistant', 'settings'],
    ['/connectors/', 'settings'],
    ['/skills/', 'settings'],
  ])('puts %s under %s', (pathname, section) => {
    expect(navigationSection(pathname)).toBe(section)
  })

  it('does not match a route that only shares a prefix', () => {
    expect(navigationSection('/hubble')).toBe('chat')
    expect(navigationSection('/apiary')).toBe('chat')
    expect(navigationSection('/downloadsx')).toBe('chat')
  })
})

describe('isPathActive', () => {
  it('ignores a trailing slash on either side', () => {
    expect(normalizePath('/hub/')).toBe('/hub')
    expect(normalizePath('/')).toBe('/')
    expect(isPathActive('/hub', '/hub/')).toBe(true)
    expect(isPathActive('/hub/', '/hub')).toBe(true)
  })

  it('matches nested routes only when asked to', () => {
    expect(isPathActive('/images/create', '/images/')).toBe(false)
    expect(isPathActive('/images/create', '/images/', true)).toBe(true)
    expect(isPathActive('/imagesx', '/images/', true)).toBe(false)
  })
})
