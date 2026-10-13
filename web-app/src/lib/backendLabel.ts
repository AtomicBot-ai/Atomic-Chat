/**
 * The name a person knows a llama.cpp build variant by (`win-cuda-13.3-x64` →
 * `CUDA 13`), for the backend dialog. The same reading
 * `llamacpp-upstream-extension`'s `friendlyBackendLabel` gives, which the
 * dialog showed while the extension opened it.
 */
export function friendlyBackendLabel(backend: string): string {
  const id = backend.replace(/\uFEFF/g, '').trim()
  if (id.endsWith('cpu-x64') || id.endsWith('cpu-arm64')) return 'CPU'
  if (id.includes('opencl-adreno')) return 'OpenCL (Adreno)'
  if (id.includes('cuda-13')) return 'CUDA 13'
  if (id.includes('cuda-12')) return 'CUDA 12'
  if (id.includes('rocm')) {
    const version = /rocm-(\d+\.\d+)/.exec(id)?.[1]
    return version ? `ROCm ${version} (~1 GB)` : 'ROCm (~1 GB)'
  }
  if (id.includes('vulkan')) return 'Vulkan'
  if (id === 'macos-arm64') return 'Apple Silicon'
  if (id === 'macos-x64') return 'Intel'
  return id
}
