// Types

/**
 * Which device the loaded model actually runs on, parsed from the llama-server
 * startup log. `--list-devices` only reports what a binary can enumerate, so it
 * cannot tell a healthy GPU load apart from a CUDA/Vulkan build that silently
 * degraded to CPU (missing cudart, parked dGPU, driver/ABI mismatch).
 */
export interface RuntimeDeviceInfo {
  /** Backend libraries the process loaded: `CUDA`, `Vulkan`, `Metal`, `CPU`, ... */
  loaded_backends: string[]
  /** Buffer label holding most of the weights: `CUDA0`, `Vulkan0`, `Metal`, `CPU`. */
  primary_device: string
  gpu_layers_offloaded?: number | null
  total_layers?: number | null
  gpu_buffer_bytes?: number | null
  /** The binary needs a CUDA runtime that is not installed on this host. */
  cuda_runtime_missing?: boolean
  /** First device-initialisation failure the backend reported, verbatim. */
  device_init_error?: string | null
}

export interface SessionInfo {
  pid: number
  port: number
  model_id: string
  model_path: string
  is_embedding: boolean
  api_key: string
  mmproj_path?: string
  runtime_device?: RuntimeDeviceInfo | null
}

export interface UnloadResult {
  success: boolean
  error?: string
}

export interface DeviceInfo {
  id: string
  name: string
  memory: number
}

export interface GgufMetadata {
  version: number
  tensor_count: number
  metadata: Record<string, string>
}

// llama.cpp settings
export type LlamacppConfig = {
  version_backend: string
  auto_unload: boolean
  timeout: number
  llamacpp_env: string
  fit: boolean
  fit_target: string
  fit_ctx: string
  chat_template: string
  n_gpu_layers: number
  offload_mmproj: boolean
  cpu_moe: boolean
  n_cpu_moe: number
  override_tensor_buffer_t: string
  ctx_size: number
  threads: number
  threads_batch: number
  n_predict: number
  batch_size: number
  ubatch_size: number
  device: string
  split_mode: string
  main_gpu: number
  flash_attn: string
  cont_batching: boolean
  no_mmap: boolean
  mlock: boolean
  no_kv_offload: boolean
  cache_type_k: string
  cache_type_v: string
  defrag_thold: number
  rope_scaling: string
  rope_scale: number
  rope_freq_base: number
  rope_freq_scale: number
  ctx_shift: boolean
  parallel: number
  concurrent_mode: boolean
  concurrent_slots: number
  expose_metrics: boolean
  reasoning_preserve: boolean
  extra_args: string
}

export type ModelPlan = {
  gpuLayers: number
  maxContextLength: number
  noOffloadKVCache: boolean
  offloadMmproj?: boolean
  batchSize: number
  mode: 'GPU' | 'Hybrid' | 'CPU' | 'Unsupported'
}

export interface DownloadItem {
  url: string
  save_path: string
  proxy?: Record<string, string | string[] | boolean>
  sha256?: string
  size?: number
  model_id?: string
}

export interface ModelConfig {
  model_path: string
  mmproj_path?: string
  name: string // user-friendly
  // some model info that we cache upon import
  size_bytes: number
  sha256?: string
  mmproj_sha256?: string
  mmproj_size_bytes?: number
  embedding?: boolean
  source?: string
}

export interface EmbeddingResponse {
  model: string
  object: string
  usage: {
    prompt_tokens: number
    total_tokens: number
  }
  data: EmbeddingData[]
}

export interface EmbeddingData {
  embedding: number[]
  index: number
  object: string
}

export interface DeviceList {
  id: string
  name: string
  mem: number
  free: number
}

export interface SystemMemory {
  totalVRAM: number
  totalRAM: number
  totalMemory: number
}

// backend types
export type BackendVersion = {
  version: string
  backend: string
  order?: number
}

export type BackendFeatures = {
  cuda11: boolean
  cuda12: boolean
  cuda13: boolean
  vulkan: boolean
  /** AMD ROCm, Linux only: a supported RDNA2–RDNA4 GPU plus a host runtime. */
  rocm: boolean
}

export type SupportedFeatures = {
  avx: boolean
  avx2: boolean
  avx512: boolean
  cuda11: boolean
  cuda12: boolean
  cuda13: boolean
  vulkan: boolean
  rocm: boolean
}
export type NvidiaInfo = {
  compute_capability: string
}

export type VulkanInfo = {
  api_version: string
}

export type GpuInfo = {
  driver_version: string
  nvidia_info?: NvidiaInfo | null
  vulkan_info?: VulkanInfo | null
}

export interface BestBackendResult {
  backend_string: string
  version: string
  backend_type: string
}

export interface UpdateCheckResult {
  update_needed: boolean
  new_version: string
  target_backend?: string
}

export interface SettingUpdateResult {
  backend_type_updated: boolean
  effective_backend_type?: string
  needs_backend_installation: boolean
  version?: string
  backend?: string
}

export interface BundledBackendResult {
  installed: boolean
  backend_string?: string
  version?: string
  backend?: string
}
