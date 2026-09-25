import { invoke } from '@tauri-apps/api/core'
import {
  GgufMetadata,
  BackendVersion,
  BackendFeatures,
  SupportedFeatures,
  GpuInfo,
  BestBackendResult,
  UpdateCheckResult,
  SettingUpdateResult,
  BundledBackendResult,
} from './types'

// GGUF commands
export async function readGgufMetadata(path: string): Promise<GgufMetadata> {
  return await invoke('plugin:llamacpp|read_gguf_metadata', { path })
}

/**
 * `cacheTypeK` / `cacheTypeV` are the KV cache types the model will load
 * with; without them the estimate assumes fp16, which overstates a quantised
 * cache several-fold.
 */
export async function isModelSupported(
  path: string,
  ctxSize?: number,
  cacheTypeK?: string,
  cacheTypeV?: string
): Promise<'RED' | 'YELLOW' | 'GREEN'> {
  return await invoke('plugin:llamacpp|is_model_supported', {
    path,
    ctxSize,
    cacheTypeK,
    cacheTypeV,
  })
}

// backend functions

/*
 * Helper function to map an old backend type string to its new, common equivalent.
 * This is used for migrating stored user preferences.
 */
export async function mapOldBackendToNew(oldBackend: string): Promise<string> {
  return await invoke<string>('plugin:llamacpp|map_old_backend_to_new', {
    oldBackend,
  })
}

export async function getLocalInstalledBackendsInternal(
  backendsDir: string
): Promise<BackendVersion[]> {
  return await invoke<BackendVersion[]>(
    'plugin:llamacpp|get_local_installed_backends',
    {
      backendsDir,
    }
  )
}

export function normalizeFeatures(features: any): BackendFeatures {
  return {
    cuda11: features.cuda11 || false,
    cuda12: features.cuda12 || false,
    cuda13: features.cuda13 || false,
    vulkan: features.vulkan || false,
    rocm: features.rocm || false,
  }
}

export async function determineSupportedBackends(
  osType: string,
  arch: string,
  features: BackendFeatures
): Promise<string[]> {
  return invoke<string[]>('plugin:llamacpp|determine_supported_backends', {
    osType,
    arch,
    features,
  })
}

export async function listSupportedBackendsFromRust(
  remoteBackendVersions: BackendVersion[],
  localBackendVersions: BackendVersion[]
): Promise<BackendVersion[]> {
  return invoke<BackendVersion[]>('plugin:llamacpp|list_supported_backends', {
    remoteBackendVersions,
    localBackendVersions,
  })
}

export async function getSupportedFeaturesFromRust(
  osType: string,
  cpuExtensions: string[],
  gpus: GpuInfo[]
): Promise<SupportedFeatures> {
  return invoke<SupportedFeatures>('plugin:llamacpp|get_supported_features', {
    osType,
    cpuExtensions,
    gpus,
  })
}

export async function findLatestVersionForBackend(
  versionBackends: BackendVersion[],
  backendType: string
): Promise<string | null> {
  return invoke('plugin:llamacpp|find_latest_version_for_backend', {
    versionBackends,
    backendType,
  })
}

export async function prioritizeBackends(
  versionBackends: BackendVersion[],
  hasEnoughGpuMemory: boolean
): Promise<BestBackendResult> {
  return invoke('plugin:llamacpp|prioritize_backends', {
    versionBackends,
    hasEnoughGpuMemory,
  })
}

export async function checkBackendForUpdates(
  currentBackendString: string,
  versionBackends: BackendVersion[]
): Promise<UpdateCheckResult> {
  return invoke('plugin:llamacpp|check_backend_for_updates', {
    currentBackendString,
    versionBackends,
  })
}

export async function removeOldBackendVersions(
  backendsDir: string,
  latestVersion: string,
  backendType: string
): Promise<string[]> {
  return invoke('plugin:llamacpp|remove_old_backend_versions', {
    backendsDir,
    latestVersion,
    backendType,
  })
}

export async function shouldMigrateBackend(
  storedBackendType: string,
  versionBackends: BackendVersion[]
): Promise<string | null> {
  return invoke('plugin:llamacpp|should_migrate_backend', {
    storedBackendType,
    versionBackends,
  })
}

export async function handleSettingUpdate(
  key: string,
  value: string,
  currentStoredBackend?: string
): Promise<SettingUpdateResult> {
  return invoke('plugin:llamacpp|handle_setting_update', {
    key,
    value,
    currentStoredBackend,
  })
}

export async function installBundledBackend(
  backendsDir: string
): Promise<BundledBackendResult> {
  return invoke('plugin:llamacpp|install_bundled_backend', { backendsDir })
}

export * from './types'
