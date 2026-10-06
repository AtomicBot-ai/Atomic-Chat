import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  isAnyDecisionHostSupported,
  isDecisionHostSupported,
} from '../platform'

const onHost = (os: 'macos' | 'windows' | 'linux') => {
  vi.stubGlobal('IS_MACOS', os === 'macos')
  vi.stubGlobal('IS_WINDOWS', os === 'windows')
  vi.stubGlobal('IS_LINUX', os === 'linux')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isDecisionHostSupported', () => {
  it('runs on Apple silicon only on macOS', () => {
    onHost('macos')
    expect(isDecisionHostSupported('aarch64')).toBe(true)
    expect(isDecisionHostSupported('x86_64')).toBe(false)
  })

  it('runs on x64 only on Windows and Linux', () => {
    for (const os of ['windows', 'linux'] as const) {
      onHost(os)
      expect(isDecisionHostSupported('x86_64')).toBe(true)
      expect(isDecisionHostSupported('aarch64')).toBe(false)
    }
  })

  it('counts an arch not reported yet as supported', () => {
    onHost('macos')
    expect(isDecisionHostSupported('')).toBe(true)
    expect(isDecisionHostSupported(undefined)).toBe(true)
  })
})

describe('isDecisionHostSupported for stock llama.cpp', () => {
  it('adds Windows on arm64, where TurboQuant has no build', () => {
    onHost('windows')
    expect(isDecisionHostSupported('aarch64', 'llamacpp-upstream')).toBe(true)
    expect(isDecisionHostSupported('aarch64', 'llamacpp')).toBe(false)
    expect(isAnyDecisionHostSupported('aarch64')).toBe(true)
  })

  it('stays off where the conf mirror carries no build: macOS x64, Linux arm64', () => {
    onHost('macos')
    expect(isDecisionHostSupported('x86_64', 'llamacpp-upstream')).toBe(false)
    expect(isAnyDecisionHostSupported('x86_64')).toBe(false)
    onHost('linux')
    expect(isDecisionHostSupported('aarch64', 'llamacpp-upstream')).toBe(false)
    expect(isDecisionHostSupported('x86_64', 'llamacpp-upstream')).toBe(true)
  })
})
