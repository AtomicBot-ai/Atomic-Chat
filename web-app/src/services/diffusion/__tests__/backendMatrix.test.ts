import { describe, expect, it } from 'vitest'

import {
  backendKindOf,
  companionFor,
  LINUX_VULKAN_MIN_VRAM_MIB,
  selectDiffusionBackend,
  type DiffusionBackendSelectionInput,
} from '../backendMatrix'

const MANIFEST_IDS = [
  'macos-arm64',
  'win-cuda12-x64',
  'win-rocm-7.14-x64',
  'win-vulkan-x64',
  'win-cpu-x64',
  'linux-vulkan-x64',
  'linux-rocm-7.14-x64',
  'linux-cpu-x64',
  'win-cudart-cu12',
]

/** A manifest after the Atomic arm64 builds were mirrored beside upstream's. */
const ARM64_IDS = [
  'linux-cuda13-arm64',
  'linux-cpu-arm64',
  'win-cuda13-arm64',
  'win-cpu-arm64',
]
const WITH_ARM64 = [...MANIFEST_IDS, ...ARM64_IDS]

const host = (
  overrides: Partial<DiffusionBackendSelectionInput>
): DiffusionBackendSelectionInput => ({
  os: 'windows',
  arch: 'x64',
  features: {},
  gpus: [],
  available: MANIFEST_IDS,
  ...overrides,
})

describe('selectDiffusionBackend on macOS', () => {
  it('installs the Metal build on Apple Silicon', () => {
    expect(selectDiffusionBackend(host({ os: 'macos', arch: 'arm64' }))).toBe(
      'macos-arm64'
    )
  })

  it('has nothing for an Intel Mac', () => {
    expect(selectDiffusionBackend(host({ os: 'macos', arch: 'x64' }))).toBeNull()
  })

  it('has nothing when the manifest does not ship the Mac build', () => {
    expect(
      selectDiffusionBackend(
        host({ os: 'macos', arch: 'arm64', available: ['win-cpu-x64'] })
      )
    ).toBeNull()
  })
})

describe('selectDiffusionBackend on Windows', () => {
  it('prefers CUDA 12 when the driver supports it', () => {
    expect(
      selectDiffusionBackend(host({ features: { cuda12: true, vulkan: true } }))
    ).toBe('win-cuda12-x64')
  })

  it('runs the CUDA 12 build on a CUDA 13-only driver', () => {
    expect(selectDiffusionBackend(host({ features: { cuda13: true } }))).toBe(
      'win-cuda12-x64'
    )
  })

  it('takes ROCm over Vulkan on a supported AMD card', () => {
    expect(
      selectDiffusionBackend(host({ features: { rocm: true, vulkan: true } }))
    ).toBe('win-rocm-7.14-x64')
  })

  it('picks the newest ROCm build when a tag ships several', () => {
    expect(
      selectDiffusionBackend(
        host({
          features: { rocm: true },
          available: ['win-rocm-7.14-x64', 'win-rocm-7.2-x64', 'win-cpu-x64'],
        })
      )
    ).toBe('win-rocm-7.14-x64')
  })

  it('falls through to Vulkan when the tag has no ROCm asset', () => {
    expect(
      selectDiffusionBackend(
        host({
          features: { rocm: true, vulkan: true },
          available: ['win-vulkan-x64', 'win-cpu-x64'],
        })
      )
    ).toBe('win-vulkan-x64')
  })

  it('skips a CUDA id the manifest does not list', () => {
    expect(
      selectDiffusionBackend(
        host({
          features: { cuda12: true, vulkan: true },
          available: ['win-vulkan-x64', 'win-cpu-x64'],
        })
      )
    ).toBe('win-vulkan-x64')
  })

  it('ends on the CPU build without any accelerator', () => {
    expect(selectDiffusionBackend(host({}))).toBe('win-cpu-x64')
  })

  it('has nothing for ARM Windows on a manifest without arm64 builds', () => {
    expect(
      selectDiffusionBackend(host({ arch: 'arm64', features: { vulkan: true } }))
    ).toBeNull()
  })
})

describe('selectDiffusionBackend on Windows on Arm', () => {
  const arm = (overrides: Partial<DiffusionBackendSelectionInput>) =>
    host({ arch: 'arm64', available: WITH_ARM64, ...overrides })

  it('takes the CUDA 13 build on an N1X with a CUDA 13 driver', () => {
    expect(
      selectDiffusionBackend(arm({ features: { cuda12: true, cuda13: true, vulkan: true } }))
    ).toBe('win-cuda13-arm64')
  })

  it('never hands an arm64 host an x64 build', () => {
    for (const features of [{ cuda12: true }, { rocm: true }, { vulkan: true }, {}]) {
      expect(selectDiffusionBackend(arm({ features }))).toBe('win-cpu-arm64')
    }
  })

  it('runs the CPU build on a driver too old for CUDA 13', () => {
    expect(selectDiffusionBackend(arm({ features: { cuda12: true } }))).toBe(
      'win-cpu-arm64'
    )
  })

  it('falls back to the CPU build when the tag has no CUDA arm64 asset', () => {
    expect(
      selectDiffusionBackend(
        arm({ features: { cuda13: true }, available: [...MANIFEST_IDS, 'win-cpu-arm64'] })
      )
    ).toBe('win-cpu-arm64')
  })
})

describe('selectDiffusionBackend on Linux', () => {
  it('takes Vulkan when the loader sees a device with enough memory', () => {
    expect(
      selectDiffusionBackend(
        host({
          os: 'linux',
          features: { vulkan: true, cuda12: true },
          gpus: [{ vendor: 'NVIDIA', totalMemoryMib: LINUX_VULKAN_MIN_VRAM_MIB }],
        })
      )
    ).toBe('linux-vulkan-x64')
  })

  it('stays on the CPU build when every device is too small', () => {
    expect(
      selectDiffusionBackend(
        host({
          os: 'linux',
          features: { vulkan: true },
          gpus: [{ totalMemoryMib: LINUX_VULKAN_MIN_VRAM_MIB - 1 }],
        })
      )
    ).toBe('linux-cpu-x64')
  })

  it('ignores CUDA on Linux: there is no prebuilt for it', () => {
    expect(
      selectDiffusionBackend(
        host({
          os: 'linux',
          features: { cuda12: true },
          gpus: [{ totalMemoryMib: 24 * 1024 }],
        })
      )
    ).toBe('linux-cpu-x64')
  })

  it('takes the CUDA 13 build on a DGX Spark', () => {
    expect(
      selectDiffusionBackend(
        host({
          os: 'linux',
          arch: 'arm64',
          features: { cuda12: true, cuda13: true, vulkan: true },
          gpus: [{ vendor: 'NVIDIA', totalMemoryMib: 0 }],
          available: WITH_ARM64,
        })
      )
    ).toBe('linux-cuda13-arm64')
  })

  it('runs the arm64 CPU build on arm64 Linux without CUDA 13', () => {
    expect(
      selectDiffusionBackend(
        host({
          os: 'linux',
          arch: 'arm64',
          features: { vulkan: true },
          gpus: [{ totalMemoryMib: 8192 }],
          available: WITH_ARM64,
        })
      )
    ).toBe('linux-cpu-arm64')
  })

  it('has nothing for arm64 Linux on a manifest without arm64 builds', () => {
    expect(
      selectDiffusionBackend(
        host({ os: 'linux', arch: 'arm64', features: { cuda13: true } })
      )
    ).toBeNull()
  })

  it('stays on the CPU build when the manifest lacks the Vulkan asset', () => {
    expect(
      selectDiffusionBackend(
        host({
          os: 'linux',
          features: { vulkan: true },
          gpus: [{ totalMemoryMib: 8192 }],
          available: ['linux-cpu-x64'],
        })
      )
    ).toBe('linux-cpu-x64')
  })
})

describe('companionFor', () => {
  it('pairs the Windows CUDA build with the cudart archive', () => {
    expect(companionFor('win-cuda12-x64')).toBe('win-cudart-cu12')
  })

  it('needs nothing for every other build, arm64 CUDA included', () => {
    for (const id of WITH_ARM64.filter((id) => id !== 'win-cuda12-x64')) {
      expect(companionFor(id)).toBeNull()
    }
  })
})

describe('backendKindOf', () => {
  it('names the compute backend from the manifest id', () => {
    expect(backendKindOf('macos-arm64')).toBe('metal')
    expect(backendKindOf('win-cuda12-x64')).toBe('cuda')
    expect(backendKindOf('linux-rocm-7.14-x64')).toBe('rocm')
    expect(backendKindOf('win-vulkan-x64')).toBe('vulkan')
    expect(backendKindOf('linux-cpu-x64')).toBe('cpu')
    expect(backendKindOf('win-cuda13-arm64')).toBe('cuda')
    expect(backendKindOf('linux-cuda13-arm64')).toBe('cuda')
    expect(backendKindOf('win-cpu-arm64')).toBe('cpu')
    expect(backendKindOf('linux-cpu-arm64')).toBe('cpu')
  })
})
