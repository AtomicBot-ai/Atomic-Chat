import { describe, expect, it } from 'vitest'
import {
  classifyBackendMismatch,
  isGpuBackendCategory,
  runtimeRanOnCpu,
  type RuntimeDeviceSnapshot,
} from './util'

/**
 * Stand-in for the extension's own `get_backend_category`, using turboquant
 * clean ids. Keeps these tests about classification rather than about the
 * provider's id scheme.
 */
const categoryOf = (backend: string): string => {
  if (backend.includes('cuda-13')) return 'cuda-cu13.0'
  if (backend.includes('cuda-12')) return 'cuda-cu12.0'
  if (backend.includes('vulkan')) return 'vulkan'
  if (backend.includes('cpu')) return 'cpu'
  return 'unknown'
}

const healthyCuda: RuntimeDeviceSnapshot = {
  loaded_backends: ['CUDA', 'CPU'],
  primary_device: 'CUDA0',
  gpu_layers_offloaded: 33,
  total_layers: 33,
}

describe('isGpuBackendCategory', () => {
  it('accepts every CUDA tier and Vulkan', () => {
    for (const category of [
      'cuda-cu13',
      'cuda-cu13.0',
      'cuda-cu12.4',
      'cuda-cu12.0',
      'cuda-cu11.7',
      'vulkan',
    ]) {
      expect(isGpuBackendCategory(category)).toBe(true)
    }
  })

  it('rejects CPU tiers and unknowns', () => {
    for (const category of ['cpu', 'common_cpus', 'avx2', 'avx512', 'unknown']) {
      expect(isGpuBackendCategory(category)).toBe(false)
    }
  })
})

describe('runtimeRanOnCpu', () => {
  it('is conclusive on zero offloaded layers', () => {
    expect(runtimeRanOnCpu({ gpu_layers_offloaded: 0 })).toBe(true)
  })

  it('recognises every CPU buffer label', () => {
    expect(runtimeRanOnCpu({ primary_device: 'CPU' })).toBe(true)
    expect(runtimeRanOnCpu({ primary_device: 'CPU_Mapped' })).toBe(true)
    expect(runtimeRanOnCpu({ primary_device: 'CPU_AARCH64' })).toBe(true)
  })

  it('never guesses without evidence', () => {
    expect(runtimeRanOnCpu(null)).toBe(false)
    expect(runtimeRanOnCpu(undefined)).toBe(false)
    expect(runtimeRanOnCpu({})).toBe(false)
    expect(runtimeRanOnCpu({ primary_device: '' })).toBe(false)
  })

  it('accepts a healthy GPU load', () => {
    expect(runtimeRanOnCpu(healthyCuda)).toBe(false)
    expect(runtimeRanOnCpu({ primary_device: 'Vulkan0' })).toBe(false)
    expect(runtimeRanOnCpu({ primary_device: 'Metal' })).toBe(false)
  })
})

describe('classifyBackendMismatch', () => {
  it('reports ok for a healthy GPU load on the ideal tier', () => {
    expect(
      classifyBackendMismatch({
        configuredBackend: 'windows-x64-cuda-13.3',
        effectiveBackend: 'windows-x64-cuda-13.3',
        runtimeDevice: healthyCuda,
        idealBackend: 'windows-x64-cuda-13.3',
        categoryOf,
      })
    ).toEqual({ kind: 'ok' })
  })

  it('reports a silent in-memory swap', () => {
    expect(
      classifyBackendMismatch({
        configuredBackend: 'windows-x64-cuda-13.3',
        effectiveBackend: 'windows-x64-cpu',
        runtimeDevice: { primary_device: 'CPU_Mapped' },
        categoryOf,
      })
    ).toEqual({
      kind: 'silent-fallback',
      configured: 'windows-x64-cuda-13.3',
      effective: 'windows-x64-cpu',
    })
  })

  it('prefers the silent swap over the runtime evidence it causes', () => {
    // A Tier-3 degrade lands on the bundled CPU build, so the model does run on
    // the CPU — but naming the swap is the more actionable message.
    const result = classifyBackendMismatch({
      configuredBackend: 'windows-x64-cuda-12.4',
      effectiveBackend: 'windows-x64-cpu',
      runtimeDevice: { gpu_layers_offloaded: 0, total_layers: 33 },
      idealBackend: 'windows-x64-cuda-12.4',
      categoryOf,
    })
    expect(result.kind).toBe('silent-fallback')
  })

  it('reports a GPU build that ran on the CPU', () => {
    expect(
      classifyBackendMismatch({
        configuredBackend: 'windows-x64-cuda-12.4',
        effectiveBackend: 'windows-x64-cuda-12.4',
        runtimeDevice: {
          loaded_backends: ['CPU'],
          primary_device: 'CPU_Mapped',
          gpu_layers_offloaded: 0,
          total_layers: 33,
        },
        categoryOf,
      })
    ).toEqual({
      kind: 'runtime-cpu',
      configured: 'windows-x64-cuda-12.4',
      primaryDevice: 'CPU_Mapped',
      offloaded: 0,
      total: 33,
      gpuKind: 'cuda',
      cudaRuntimeMissing: false,
      deviceInitError: null,
    })
  })

  it('carries the missing-runtime reason so the fix can be named', () => {
    const result = classifyBackendMismatch({
      configuredBackend: 'windows-x64-cuda-12.4',
      effectiveBackend: 'windows-x64-cuda-12.4',
      runtimeDevice: {
        primary_device: 'CPU',
        cuda_runtime_missing: true,
        device_init_error: 'error while loading shared libraries: libcudart.so.12',
      },
      categoryOf,
    })
    expect(result).toMatchObject({
      kind: 'runtime-cpu',
      cudaRuntimeMissing: true,
      deviceInitError: 'error while loading shared libraries: libcudart.so.12',
    })
  })

  it('treats device_init_error alone as runtime-cpu even with empty primary', () => {
    // Repro from Windows TurboQuant CUDA zips missing cudart: llama.cpp prints
    // "no usable GPU found" before any load_tensors lines, so the snapshot is
    // backends=[], primary="", offloaded=None — previously classified as ok.
    expect(
      classifyBackendMismatch({
        configuredBackend: 'windows-x64-cuda-13.3',
        effectiveBackend: 'windows-x64-cuda-13.3',
        runtimeDevice: {
          loaded_backends: [],
          primary_device: '',
          device_init_error:
            'warning: no usable GPU found, --gpu-layers option will be ignored',
        },
        categoryOf,
      })
    ).toEqual({
      kind: 'runtime-cpu',
      configured: 'windows-x64-cuda-13.3',
      primaryDevice: 'CPU',
      offloaded: null,
      total: null,
      gpuKind: 'cuda',
      cudaRuntimeMissing: false,
      deviceInitError:
        'warning: no usable GPU found, --gpu-layers option will be ignored',
    })
  })

  it('treats cuda_runtime_missing alone as runtime-cpu', () => {
    expect(
      classifyBackendMismatch({
        configuredBackend: 'windows-x64-cuda-13.3',
        effectiveBackend: 'windows-x64-cuda-13.3',
        runtimeDevice: {
          cuda_runtime_missing: true,
        },
        categoryOf,
      })
    ).toMatchObject({
      kind: 'runtime-cpu',
      cudaRuntimeMissing: true,
      primaryDevice: 'CPU',
    })
  })

  it('stays silent when the user asked for CPU-only with GPU Layers = 0', () => {
    // The "GPU Layers" model setting documents 0 as CPU only, so `-ngl 0` and
    // `offloaded 0/33` are what was requested. Warning here would train the
    // user to suppress the prompt before a real degradation ever happens.
    expect(
      classifyBackendMismatch({
        configuredBackend: 'windows-x64-cuda-12.4',
        effectiveBackend: 'windows-x64-cuda-12.4',
        runtimeDevice: {
          primary_device: 'CPU_Mapped',
          gpu_layers_offloaded: 0,
          total_layers: 33,
        },
        idealBackend: 'windows-x64-cuda-12.4',
        requestedGpuLayers: 0,
        categoryOf,
      })
    ).toEqual({ kind: 'ok' })
  })

  it('still reports a degradation when layers were requested', () => {
    expect(
      classifyBackendMismatch({
        configuredBackend: 'windows-x64-cuda-12.4',
        effectiveBackend: 'windows-x64-cuda-12.4',
        runtimeDevice: {
          primary_device: 'CPU_Mapped',
          gpu_layers_offloaded: 0,
          total_layers: 33,
        },
        requestedGpuLayers: 100,
        categoryOf,
      })
    ).toMatchObject({ kind: 'runtime-cpu' })
  })

  it('names Vulkan as the stack when an AMD Vulkan build ran on the CPU', () => {
    // Vulkan is the only GPU path for AMD on Linux, so this is the AMD case of
    // the same bug. The advice differs from CUDA's: driver, not runtime.
    expect(
      classifyBackendMismatch({
        configuredBackend: 'linux-x64-vulkan',
        effectiveBackend: 'linux-x64-vulkan',
        runtimeDevice: {
          loaded_backends: ['CPU'],
          primary_device: 'CPU',
          gpu_layers_offloaded: 0,
          total_layers: 33,
          device_init_error: 'ggml_vulkan: No devices found',
        },
        categoryOf,
      })
    ).toMatchObject({
      kind: 'runtime-cpu',
      gpuKind: 'vulkan',
      cudaRuntimeMissing: false,
      deviceInitError: 'ggml_vulkan: No devices found',
    })
  })

  it('does not call a Vulkan build degraded without runtime evidence', () => {
    expect(
      classifyBackendMismatch({
        configuredBackend: 'linux-x64-vulkan',
        effectiveBackend: 'linux-x64-vulkan',
        runtimeDevice: null,
        idealBackend: 'linux-x64-vulkan',
        categoryOf,
      })
    ).toEqual({ kind: 'ok' })
  })

  it('leaves a CPU build alone when it runs on the CPU as expected', () => {
    expect(
      classifyBackendMismatch({
        configuredBackend: 'windows-x64-cpu',
        effectiveBackend: 'windows-x64-cpu',
        runtimeDevice: { primary_device: 'CPU_Mapped', gpu_layers_offloaded: 0 },
        categoryOf,
      })
    ).toEqual({ kind: 'ok' })
  })

  it('offers a better tier when the host has one', () => {
    expect(
      classifyBackendMismatch({
        configuredBackend: 'windows-x64-cpu',
        effectiveBackend: 'windows-x64-cpu',
        runtimeDevice: { primary_device: 'CPU_Mapped' },
        idealBackend: 'windows-x64-cuda-13.3',
        categoryOf,
      })
    ).toEqual({
      kind: 'suboptimal-config',
      configured: 'windows-x64-cpu',
      ideal: 'windows-x64-cuda-13.3',
    })
  })

  it('never nudges toward a CPU tier', () => {
    expect(
      classifyBackendMismatch({
        configuredBackend: 'windows-x64-vulkan',
        effectiveBackend: 'windows-x64-vulkan',
        runtimeDevice: { primary_device: 'Vulkan0' },
        idealBackend: 'windows-x64-cpu',
        categoryOf,
      })
    ).toEqual({ kind: 'ok' })
  })

  it('treats a different tag of the same tier as already optimal', () => {
    expect(
      classifyBackendMismatch({
        configuredBackend: 'windows-x64-cuda-13.3',
        effectiveBackend: 'windows-x64-cuda-13.3',
        runtimeDevice: healthyCuda,
        idealBackend: 'windows-x64-cuda-13.8',
        categoryOf,
      })
    ).toEqual({ kind: 'ok' })
  })

  it('stays quiet when no backend is configured yet', () => {
    expect(
      classifyBackendMismatch({
        configuredBackend: '',
        effectiveBackend: '',
        idealBackend: 'windows-x64-cuda-13.3',
        categoryOf,
      })
    ).toEqual({ kind: 'ok' })
  })

  it('tolerates BOM and surrounding whitespace', () => {
    expect(
      classifyBackendMismatch({
        configuredBackend: '\uFEFF windows-x64-cuda-13.3 ',
        effectiveBackend: 'windows-x64-cuda-13.3',
        runtimeDevice: healthyCuda,
        categoryOf,
      })
    ).toEqual({ kind: 'ok' })
  })

  it('falls back to the configured backend when none was launched', () => {
    expect(
      classifyBackendMismatch({
        configuredBackend: 'windows-x64-cuda-12.4',
        effectiveBackend: null,
        runtimeDevice: { gpu_layers_offloaded: 0, total_layers: 33 },
        categoryOf,
      })
    ).toMatchObject({ kind: 'runtime-cpu', configured: 'windows-x64-cuda-12.4' })
  })
})
