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

  it('has nothing for ARM Windows', () => {
    expect(
      selectDiffusionBackend(host({ arch: 'arm64', features: { vulkan: true } }))
    ).toBeNull()
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

  it('needs nothing for every other build', () => {
    for (const id of MANIFEST_IDS.filter((id) => id !== 'win-cuda12-x64')) {
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
  })
})
