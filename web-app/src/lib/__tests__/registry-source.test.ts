import { describe, expect, it } from 'vitest'

import { REGISTRY_OVERRIDES, registryOverrideUrl } from '../registry-source'

describe('registryOverrideUrl', () => {
  it.each([
    undefined,
    null,
    '',
    '   ',
    42,
    'not a url',
    'ftp://x.example/a.json',
    'file:///etc/passwd',
  ])('treats %j as "bundled only"', (raw) => {
    expect(registryOverrideUrl(raw)).toBeNull()
  })

  it('accepts an absolute http(s) URL, trimmed', () => {
    expect(registryOverrideUrl(' https://registry.example/a.json ')).toBe(
      'https://registry.example/a.json'
    )
    expect(registryOverrideUrl('http://127.0.0.1:8080/a.json')).toBe(
      'http://127.0.0.1:8080/a.json'
    )
  })
})

describe('REGISTRY_OVERRIDES', () => {
  // The default build reaches no registry host at all.
  it('is empty unless the build sets a VITE_*_URL', () => {
    for (const [name, url] of Object.entries(REGISTRY_OVERRIDES)) {
      expect(url, name).toBeNull()
    }
  })
})
