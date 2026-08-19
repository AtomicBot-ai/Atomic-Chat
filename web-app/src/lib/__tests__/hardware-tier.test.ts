import { describe, expect, it } from 'vitest'
import {
  classifyHardwareTier,
  isArmArch,
  LOW_SPEC_UNIFIED_MEMORY_MIB,
  LOW_SPEC_VRAM_MIB,
} from '../hardware-tier'

const GIB = 1024

describe('isArmArch', () => {
  it('recognises the arm spellings and rejects x86', () => {
    expect(isArmArch('arm64')).toBe(true)
    expect(isArmArch('aarch64')).toBe(true)
    expect(isArmArch('ARM64')).toBe(true)
    expect(isArmArch('x86_64')).toBe(false)
    expect(isArmArch(undefined)).toBe(false)
  })
})

describe('classifyHardwareTier', () => {
  describe('macOS', () => {
    // The whole reason the macOS branch runs first: the hardware plugin skips
    // the Vulkan probe on macOS, so every Mac reports an empty GPU list. If the
    // VRAM branch were reachable it would read 0 MiB and call a Mac Studio
    // low-spec.
    it('judges a Mac on unified memory even though it reports no GPUs', () => {
      expect(
        classifyHardwareTier({
          os_type: 'macos',
          cpu: { arch: 'arm64' },
          total_memory: 128 * GIB,
          gpus: [],
        })
      ).toBe('standard')
    })

    it('calls an 8 GB Apple Silicon Mac low-spec', () => {
      expect(
        classifyHardwareTier({
          os_type: 'macos',
          cpu: { arch: 'arm64' },
          total_memory: 8 * GIB,
          gpus: [],
        })
      ).toBe('low')
    })

    it('treats exactly 16 GB as standard', () => {
      expect(
        classifyHardwareTier({
          os_type: 'macos',
          cpu: { arch: 'arm64' },
          total_memory: LOW_SPEC_UNIFIED_MEMORY_MIB,
          gpus: [],
        })
      ).toBe('standard')
    })

    it('applies the same memory rule to Intel Macs', () => {
      expect(
        classifyHardwareTier({
          os_type: 'macos',
          cpu: { arch: 'x86_64' },
          total_memory: 32 * GIB,
          gpus: [],
        })
      ).toBe('standard')
    })
  })

  describe('machines with an enumerated GPU', () => {
    it('calls a 6 GB card low-spec and an 8 GB card standard', () => {
      const withVram = (mib: number) =>
        classifyHardwareTier({
          os_type: 'windows',
          cpu: { arch: 'x86_64' },
          total_memory: 32 * GIB,
          gpus: [{ total_memory: mib }],
        })

      expect(withVram(6 * GIB)).toBe('low')
      expect(withVram(LOW_SPEC_VRAM_MIB)).toBe('standard')
    })

    it('takes the largest card rather than the sum', () => {
      // Two 6 GB cards cannot stand in for one 12 GB card, so this must stay
      // 'low' — summing would wrongly report 12 GB and pass.
      expect(
        classifyHardwareTier({
          os_type: 'windows',
          cpu: { arch: 'x86_64' },
          total_memory: 64 * GIB,
          gpus: [{ total_memory: 6 * GIB }, { total_memory: 6 * GIB }],
        })
      ).toBe('low')

      expect(
        classifyHardwareTier({
          os_type: 'windows',
          cpu: { arch: 'x86_64' },
          total_memory: 64 * GIB,
          gpus: [{ total_memory: 6 * GIB }, { total_memory: 24 * GIB }],
        })
      ).toBe('standard')
    })
  })

  describe('machines without a GPU', () => {
    it('applies the unified-memory rule to ARM hosts', () => {
      const arm = (mib: number) =>
        classifyHardwareTier({
          os_type: 'windows',
          cpu: { arch: 'aarch64' },
          total_memory: mib,
          gpus: [],
        })

      expect(arm(8 * GIB)).toBe('low')
      expect(arm(32 * GIB)).toBe('standard')
    })

    it('calls an x86 host with integrated graphics low-spec', () => {
      expect(
        classifyHardwareTier({
          os_type: 'windows',
          cpu: { arch: 'x86_64' },
          total_memory: 64 * GIB,
          gpus: [],
        })
      ).toBe('low')
    })
  })

  it('returns null when hardware has not been enumerated yet', () => {
    expect(
      classifyHardwareTier({
        os_type: '',
        cpu: { arch: '' },
        total_memory: 0,
        gpus: [],
      })
    ).toBeNull()
    expect(classifyHardwareTier({})).toBeNull()
    // A Mac whose memory has not been read yet must also stay undecided
    // rather than defaulting to low.
    expect(classifyHardwareTier({ os_type: 'macos', total_memory: 0 })).toBeNull()
  })
})
