import { describe, expect, it } from 'vitest'

import { descriptorHint, isProviderHidden } from './visibility'

const blocker = (reason: string, code = 'MANAGED_PREREQUISITE_BLOCKED') => ({
  code,
  message: reason,
  reason,
})

describe('isProviderHidden', () => {
  it('hides the provider where it can neither run nor be set up', () => {
    // No NVIDIA driver answers, the driver sees no card, or core has no descriptor: the spec's
    // "no NVIDIA card" and "descriptor not published" (ruling R-app-5).
    expect(isProviderHidden({ availability: 'unsupported', blockers: [] })).toBe(true)
    for (const reason of ['driver-missing', 'no-gpu']) {
      expect(
        isProviderHidden({ availability: 'prerequisite-blocked', blockers: [blocker(reason)] })
      ).toBe(true)
    }
    expect(
      isProviderHidden({
        availability: 'prerequisite-blocked',
        blockers: [blocker('descriptor-unavailable', 'MANAGED_METADATA_INVALID')],
      })
    ).toBe(true)
  })

  it('shows every other blocker, so the user learns what to fix', () => {
    for (const reason of ['compute-capability-too-low', 'driver-too-old', 'docker-snap', 'podman-docker']) {
      expect(
        isProviderHidden({ availability: 'prerequisite-blocked', blockers: [blocker(reason)] })
      ).toBe(false)
    }
  })

  it('on Windows, hides it where the core answers unsupported and shows what the person can fix', () => {
    // Change add-tensorrt-llm-windows: Windows on ARM, a build older than Windows 11 and no
    // `windows.json` in conf are `unsupported`; the WSL blockers carry instructions and stay shown.
    for (const reason of ['unsupported-architecture', 'windows-build-too-old', 'environment-manifest-unavailable']) {
      expect(isProviderHidden({ availability: 'unsupported', blockers: [blocker(reason)] })).toBe(true)
    }
    for (const reason of ['wsl-version', 'virtualization-disabled', 'foreign-distribution', 'elevated-process']) {
      expect(
        isProviderHidden({ availability: 'prerequisite-blocked', blockers: [blocker(reason)] })
      ).toBe(false)
    }
  })

  it('shows a host that can be set up or already runs the engine', () => {
    expect(isProviderHidden({ availability: 'setup-required', blockers: [] })).toBe(false)
    expect(isProviderHidden({ availability: 'supported', blockers: [] })).toBe(false)
  })
})

describe('descriptorHint', () => {
  it('names the installed descriptor when the engine is installed', () => {
    expect(
      descriptorHint([
        {
          installations: [
            { engine_id: 'tensorrt-llm', active_descriptor_id: 'tensorrt-llm-1.2.1-r1' },
          ],
        },
      ])
    ).toBe('tensorrt-llm-1.2.1-r1')
  })

  it('falls back to the engine id, which core resolves to its newest descriptor', () => {
    // Ruling R-app-4: the probe needs an id before anything is installed.
    expect(descriptorHint([])).toBe('tensorrt-llm')
    expect(
      descriptorHint([
        { installations: [{ engine_id: 'tensorrt-llm', active_descriptor_id: null }] },
      ])
    ).toBe('tensorrt-llm')
  })
})
