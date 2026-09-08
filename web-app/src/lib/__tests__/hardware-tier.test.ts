import { describe, expect, it } from 'vitest'
import {
  classifyHardwareTier,
  describeHardware,
  isArmArch,
  isHardwareTier,
  judgeMemoryFit,
  memoryCeilingBytes,
  MACOS_LOAD_CEILING,
  type HardwareProfile,
} from '../hardware-tier'

const GIB = 1024
const GIB_BYTES = 1024 ** 3

const mac = (ramGib: number) =>
  classifyHardwareTier({
    os_type: 'macos',
    cpu: { arch: 'arm64' },
    total_memory: ramGib * GIB,
    gpus: [],
  })

const pc = (vramGib: number, ramGib = 32) =>
  classifyHardwareTier({
    os_type: 'windows',
    cpu: { arch: 'x86_64' },
    total_memory: ramGib * GIB,
    gpus: [{ total_memory: vramGib * GIB }],
  })

describe('isArmArch', () => {
  it('recognises the arm spellings and rejects x86', () => {
    expect(isArmArch('arm64')).toBe(true)
    expect(isArmArch('aarch64')).toBe(true)
    expect(isArmArch('ARM64')).toBe(true)
    expect(isArmArch('x86_64')).toBe(false)
    expect(isArmArch(undefined)).toBe(false)
  })
})

describe('isHardwareTier', () => {
  it('accepts the vocabulary and rejects everything else', () => {
    expect(isHardwareTier('unified_16')).toBe(true)
    expect(isHardwareTier('cpu_only')).toBe(true)
    // The two values the flag used to take are no longer tiers — the aliasing
    // lives in `useHardwareTier`, not here.
    expect(isHardwareTier('low')).toBe(false)
    expect(isHardwareTier('standard')).toBe(false)
    expect(isHardwareTier(undefined)).toBe(false)
  })
})

describe('describeHardware', () => {
  describe('macOS', () => {
    // The whole reason the macOS branch runs first: the hardware plugin skips
    // the Vulkan probe on macOS, so every Mac reports an empty GPU list. If the
    // VRAM branch were reachable it would read 0 MiB and put a Mac Studio on
    // the weakest rung of the ladder.
    it('judges a Mac on unified memory even though it reports no GPUs', () => {
      const profile = describeHardware({
        os_type: 'macos',
        cpu: { arch: 'arm64' },
        total_memory: 128 * GIB,
        gpus: [],
      })

      expect(profile).toMatchObject({
        tier: 'unified_32_plus',
        memoryKind: 'unified',
        budgetMib: 128 * GIB,
        hardCeiling: true,
      })
    })

    it('walks the unified buckets', () => {
      expect(mac(8)).toBe('unified_8')
      expect(mac(16)).toBe('unified_16')
      expect(mac(18)).toBe('unified_32')
      expect(mac(32)).toBe('unified_32')
      expect(mac(36)).toBe('unified_32_plus')
      expect(mac(128)).toBe('unified_32_plus')
    })

    it('keeps a machine that under-reports its badge in the bucket its owner would name', () => {
      // Firmware reservations mean a nominal 16 GB Mac can report a little
      // under 16 GiB. The bounds sit half a GiB high so it still reads as 16,
      // not as an 8 GB machine given a model two rungs too light.
      expect(mac(15.6)).toBe('unified_16')
      expect(mac(7.8)).toBe('unified_8')
    })

    it('applies the same rule to Intel Macs, which also report no GPU', () => {
      expect(
        classifyHardwareTier({
          os_type: 'macos',
          cpu: { arch: 'x86_64' },
          total_memory: 32 * GIB,
          gpus: [],
        })
      ).toBe('unified_32')
    })
  })

  describe('machines with an enumerated GPU', () => {
    it('walks the VRAM buckets', () => {
      expect(pc(2)).toBe('vram_2')
      expect(pc(4)).toBe('vram_4')
      expect(pc(6)).toBe('vram_8')
      expect(pc(8)).toBe('vram_8')
      expect(pc(12)).toBe('vram_12')
      expect(pc(16)).toBe('vram_16')
      expect(pc(24)).toBe('vram_16_plus')
    })

    it('splits the weak cards at 2.5 GiB rather than lumping them under 4', () => {
      // 741 Windows devices sit under 2.5 GiB and 888 at ~4 GiB. One bucket
      // would hand the smaller half a model with no room left for its KV cache.
      expect(pc(2)).toBe('vram_2')
      expect(pc(3)).toBe('vram_4')
    })

    it('takes the largest card rather than the sum', () => {
      // Two 6 GB cards cannot stand in for one 12 GB card, so this must stay in
      // the 8 GiB bucket — summing would wrongly report 12.
      expect(
        classifyHardwareTier({
          os_type: 'windows',
          cpu: { arch: 'x86_64' },
          total_memory: 64 * GIB,
          gpus: [{ total_memory: 6 * GIB }, { total_memory: 6 * GIB }],
        })
      ).toBe('vram_8')

      expect(
        classifyHardwareTier({
          os_type: 'windows',
          cpu: { arch: 'x86_64' },
          total_memory: 64 * GIB,
          gpus: [{ total_memory: 6 * GIB }, { total_memory: 24 * GIB }],
        })
      ).toBe('vram_16_plus')
    })

    it('leaves the ceiling soft off macOS, because llama.cpp spills into RAM', () => {
      expect(
        describeHardware({
          os_type: 'windows',
          cpu: { arch: 'x86_64' },
          total_memory: 32 * GIB,
          gpus: [{ total_memory: 8 * GIB }],
        })?.hardCeiling
      ).toBe(false)
    })
  })

  describe('machines without a GPU', () => {
    it('applies the unified buckets to ARM hosts', () => {
      const arm = (gib: number) =>
        classifyHardwareTier({
          os_type: 'windows',
          cpu: { arch: 'aarch64' },
          total_memory: gib * GIB,
          gpus: [],
        })

      expect(arm(8)).toBe('unified_8')
      expect(arm(32)).toBe('unified_32')
    })

    it('calls an x86 host with no accelerator cpu_only, whatever its RAM', () => {
      // The bug this replaces: the old rule read "x86 without a GPU → low
      // spec", so a 128 GiB workstation got an 8 GiB laptop's recommendation.
      // The answer is still the lightest model — CPU throughput is what binds,
      // and more RAM does not buy any of it back — but now it says so, and the
      // profile still reports the real capacity.
      const profile = describeHardware({
        os_type: 'windows',
        cpu: { arch: 'x86_64' },
        total_memory: 128 * GIB,
        gpus: [],
      })

      expect(profile).toMatchObject({
        tier: 'cpu_only',
        memoryKind: 'system',
        budgetMib: 128 * GIB,
      })
    })
  })

  it('returns null when hardware has not been enumerated yet', () => {
    expect(
      describeHardware({
        os_type: '',
        cpu: { arch: '' },
        total_memory: 0,
        gpus: [],
      })
    ).toBeNull()
    expect(describeHardware({})).toBeNull()
    // A Mac whose memory has not been read yet must also stay undecided rather
    // than defaulting to the smallest rung.
    expect(describeHardware({ os_type: 'macos', total_memory: 0 })).toBeNull()
  })

  it('ignores a GPU that reports no memory rather than budgeting zero', () => {
    expect(
      classifyHardwareTier({
        os_type: 'windows',
        cpu: { arch: 'x86_64' },
        total_memory: 32 * GIB,
        gpus: [{ total_memory: 0 }],
      })
    ).toBe('cpu_only')
  })
})

describe('judgeMemoryFit', () => {
  const profile = (over: Partial<HardwareProfile>): HardwareProfile => ({
    tier: 'unified_16',
    memoryKind: 'unified',
    budgetMib: 16 * GIB,
    systemRamMib: 16 * GIB,
    vramMib: 0,
    hardCeiling: true,
    ...over,
  })

  it('calls half the budget comfortable — the rest is KV cache and buffers', () => {
    expect(judgeMemoryFit(7 * GIB_BYTES, profile({}))).toBe('comfortable')
  })

  it('refuses past the measured macOS ceiling', () => {
    // 0.85 is where the measured load-success rate falls from ~85 % to 69 %,
    // then 56 %, then 16 %. Metal declines the allocation; there is no spill.
    expect(judgeMemoryFit(13 * GIB_BYTES, profile({}))).toBe('tight')
    expect(judgeMemoryFit(14 * GIB_BYTES, profile({}))).toBe('wont_load')
  })

  it('calls the same overshoot a slowdown on a card, not a failure', () => {
    // On Windows/Linux llama.cpp pages the overflow through system RAM: even a
    // 2x overshoot loads more than half the time. Gating on VRAM here would
    // refuse models that demonstrably run.
    const pcProfile = profile({
      memoryKind: 'vram',
      hardCeiling: false,
      tier: 'vram_16',
    })
    expect(judgeMemoryFit(14 * GIB_BYTES, pcProfile)).toBe('tight')
    expect(judgeMemoryFit(20 * GIB_BYTES, pcProfile)).toBe('spills')
  })

  it('says nothing rather than guessing when a figure is missing', () => {
    expect(judgeMemoryFit(undefined, profile({}))).toBeNull()
    expect(judgeMemoryFit(4 * GIB_BYTES, null)).toBeNull()
    expect(judgeMemoryFit(4 * GIB_BYTES, profile({ budgetMib: 0 }))).toBeNull()
  })
})

describe('memoryCeilingBytes', () => {
  it('discounts the budget on macOS and takes it whole elsewhere', () => {
    const budgetMib = 16 * GIB
    const base: HardwareProfile = {
      tier: 'unified_16',
      memoryKind: 'unified',
      budgetMib,
      systemRamMib: budgetMib,
      vramMib: 0,
      hardCeiling: true,
    }

    expect(memoryCeilingBytes(base)).toBe(
      budgetMib * 1024 * 1024 * MACOS_LOAD_CEILING
    )
    expect(memoryCeilingBytes({ ...base, hardCeiling: false })).toBe(
      budgetMib * 1024 * 1024
    )
    expect(memoryCeilingBytes(null)).toBe(0)
  })
})
