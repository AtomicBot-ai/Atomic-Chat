import type { ServiceHub } from '@/services'
import type { HardwareData } from '@/services/hardware/types'
import { cpuAvxLevel, mapGpuVendor } from '@/lib/telemetry'

/**
 * The machine as the app reports it: to analytics as super-properties (see
 * `providers/AnalyticProvider`) and to the Atomic Chat team as support-chat
 * diagnostics (see `services/support/diagnostics`). Every IPC read is
 * time-boxed, so neither caller can be held up by a slow core.
 */

/** Resolve a promise but reject after `ms` so a slow IPC never blocks startup. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error('timeout')), ms)
    promise.then(
      (value) => {
        clearTimeout(id)
        resolve(value)
      },
      (error) => {
        clearTimeout(id)
        reject(error)
      }
    )
  })
}

/** First of `keys` that holds a value. Tolerates localStorage being unavailable. */
function firstStoredValue(keys: string[]): string | null {
  for (const key of keys) {
    try {
      const value = localStorage.getItem(key)
      if (value) return value
    } catch {
      return null
    }
  }
  return null
}

/**
 * Which llama.cpp build the device downloaded, from extension-owned
 * localStorage (no IPC, no side effects).
 *
 * ATO-468: `llama_cpp_backend_type` is dead. Both engines moved to their own
 * keys and now read the shared one only to migrate off it, so nothing writes
 * it any more and `active_backend` had been reporting whatever an old build
 * happened to leave behind. Read the live keys, most specific first.
 */
export function readDeviceBackendPref(): string | null {
  return firstStoredValue([
    'atomic_llamacpp_upstream_backend_type',
    'atomic_llamacpp_turboquant_backend_type',
    'llama_cpp_backend_type',
  ])
}

/** The build the backend check last recommended, if any. */
export function readRecommendedBackend(): string | null {
  // Same drift: only the upstream extension writes the unprefixed key.
  const recommendation = firstStoredValue([
    'llama_cpp_better_backend_recommendation',
    'turboquant_better_backend_recommendation',
  ])
  if (!recommendation) return null
  try {
    const parsed = JSON.parse(recommendation) as {
      recommendedBackend?: string
    }
    return parsed?.recommendedBackend || null
  } catch {
    // malformed cache — ignore
    return null
  }
}

/** How the app was installed, or undefined when the shell cannot tell. */
export async function readInstallerType(
  serviceHub: ServiceHub,
  timeoutMs = 1500
): Promise<string | undefined> {
  try {
    return (
      (await withTimeout(serviceHub.app().getInstallerType(), timeoutMs)) ||
      undefined
    )
  } catch {
    // best-effort — installer type unavailable
    return undefined
  }
}

/** The core's hardware facts, or null when they do not arrive in time. */
export async function readHardwareInfo(
  serviceHub: ServiceHub,
  timeoutMs = 3000
): Promise<HardwareData | null> {
  return withTimeout(serviceHub.hardware().getHardwareInfo(), timeoutMs).catch(
    () => null
  )
}

/** `arm64` for any ARM CPU, `x64` otherwise. */
export function normalizeArch(arch: string | undefined): 'arm64' | 'x64' {
  const value = (arch || '').toLowerCase()
  return value.includes('arm') || value.includes('aarch') ? 'arm64' : 'x64'
}

/**
 * ATO-111: build the hardware / OS / backend super-properties registered once
 * per launch. PII contract: never include GPU UUID/serial or the machine name;
 * RAM/VRAM are plain MiB integers. Slow IPC calls are time-boxed so `app_opened`
 * is not delayed.
 */
export async function collectHardwareSuperProps(
  serviceHub: ServiceHub
): Promise<Record<string, unknown>> {
  const props: Record<string, unknown> = {}

  const backendPref = readDeviceBackendPref()
  if (backendPref) {
    // The honest name: this is which build the device downloaded, not what
    // executed a given response — `model_load.exec_backend` answers that.
    props.device_backend_pref = backendPref
    // Kept until the dashboards reading it have moved over.
    props.active_backend = backendPref
  }
  const recommendedBackend = readRecommendedBackend()
  if (recommendedBackend) props.recommended_backend = recommendedBackend

  if (typeof IS_TAURI === 'undefined' || !IS_TAURI) return props

  const installerType = await readInstallerType(serviceHub)
  if (installerType) props.installer_type = installerType

  const hw = await readHardwareInfo(serviceHub)
  if (!hw) return props

  props.os = hw.os_type || 'unknown'
  props.os_build = hw.os_name || ''
  props.arch = normalizeArch(hw.cpu?.arch)
  props.cpu_avx = cpuAvxLevel(hw.cpu?.extensions)
  props.system_ram_mb = hw.total_memory ?? null

  const gpus = hw.gpus || []
  const primary = gpus[0]
  props.gpu_detected = gpus.length > 0
  props.gpu_vendor = mapGpuVendor(primary?.vendor, IS_MACOS)
  props.gpu_model = primary?.name || null
  props.vram_mb = primary?.total_memory ?? null

  const nvidia = gpus.find((g) =>
    (g.vendor || '').toLowerCase().includes('nvidia')
  )
  if (nvidia) {
    props.nvidia_driver_version = nvidia.driver_version || null
    // Exact CUDA runtime string is not exposed by tauri-plugin-hardware;
    // surface compute capability as a best-effort proxy (see ATO-111).
    props.cuda_runtime_version = nvidia.nvidia_info?.compute_capability || null
  }
  const vk = gpus.find((g) => g.vulkan_info?.api_version)
  if (vk) props.vulkan_version = vk.vulkan_info.api_version

  const usage = await withTimeout(
    serviceHub.hardware().getSystemUsage(),
    1500
  ).catch(() => null)
  if (usage && primary) {
    const u =
      usage.gpus?.find((g) => g.uuid === primary.uuid) ?? usage.gpus?.[0]
    if (u)
      props.vram_free_mb = Math.max(
        0,
        (u.total_memory ?? 0) - (u.used_memory ?? 0)
      )
  }

  return props
}
