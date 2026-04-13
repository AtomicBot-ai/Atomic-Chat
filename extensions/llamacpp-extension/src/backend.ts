import { getJanDataFolderPath, fs, joinPath } from '@janhq/core'
import { getSystemInfo } from '@janhq/tauri-plugin-hardware-api'
import {
  getLocalInstalledBackendsInternal,
  normalizeFeatures,
  determineSupportedBackends,
  listSupportedBackendsFromRust,
  BackendVersion,
  getSupportedFeaturesFromRust,
} from '@janhq/tauri-plugin-llamacpp-api'

const LLAMACPP_RELEASES_API =
  'https://api.github.com/repos/janhq/llama.cpp/releases/latest'
const LLAMACPP_DOWNLOAD_BASE =
  'https://github.com/janhq/llama.cpp/releases/download'

export async function getLocalInstalledBackends(): Promise<BackendVersion[]> {
  const janDataFolderPath = await getJanDataFolderPath()
  const backendDir = await joinPath([janDataFolderPath, 'llamacpp', 'backends'])
  return await getLocalInstalledBackendsInternal(backendDir)
}
// folder structure
// <Jan's data folder>/llamacpp/backends/<backend_version>/<backend_type>

/**
 * Fetches the list of available backend builds from janhq/llama.cpp GitHub
 * releases, filtered to the current platform (win/linux/macos) and arch.
 * Returns an empty array on network failure so the app can still work offline
 * with only bundled/local backends.
 */
export async function fetchRemoteBackends(): Promise<BackendVersion[]> {
  const sysInfo = await getSystemInfo()
  const osType = sysInfo.os_type
  const arch = sysInfo.cpu.arch

  // macOS uses a separate turboquant repository (AtomicBot-ai/atomic-llama-cpp-turboquant),
  // not janhq/llama.cpp, so remote backend fetching only applies to Windows and Linux.
  let platformPrefix: string
  if (osType === 'windows') {
    platformPrefix = 'win-'
  } else if (osType === 'linux') {
    platformPrefix = 'linux-'
  } else {
    return []
  }

  const archSuffix = arch.includes('aarch64') || arch.includes('arm64')
    ? 'arm64'
    : 'x64'

  try {
    const resp = await fetch(LLAMACPP_RELEASES_API, {
      headers: { 'User-Agent': 'atomic-chat' },
    })
    if (!resp.ok) {
      console.warn(
        `[fetchRemoteBackends] GitHub API returned ${resp.status}, using local backends only`
      )
      return []
    }

    const release = await resp.json()
    const tag: string = release.tag_name
    if (!tag) return []

    const assets: { name: string }[] = release.assets ?? []

    const re = new RegExp(
      `^llama-${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-bin-(.+)\\.tar\\.gz$`
    )

    const backends: BackendVersion[] = []

    for (const asset of assets) {
      const match = re.exec(asset.name)
      if (!match) continue

      const backendName = match[1]
      if (!backendName.startsWith(platformPrefix)) continue

      const matchesArch =
        backendName.endsWith(`-${archSuffix}`) ||
        backendName === `${platformPrefix}${archSuffix}`
      if (!matchesArch) continue

      backends.push({ version: tag, backend: backendName, order: 0 })
    }

    console.info(
      `[fetchRemoteBackends] Found ${backends.length} remote backends for ${platformPrefix}${archSuffix}:`,
      backends.map((b) => b.backend)
    )
    return backends
  } catch (err) {
    console.warn('[fetchRemoteBackends] Failed to fetch remote backends:', err)
    return []
  }
}

/**
 * Builds the download URL for a specific backend version from janhq/llama.cpp.
 */
export function getBackendDownloadUrl(
  version: string,
  backend: string
): string {
  return `${LLAMACPP_DOWNLOAD_BASE}/${version}/llama-${version}-bin-${backend}.tar.gz`
}

export async function listSupportedBackends(): Promise<BackendVersion[]> {
  const sysInfo = await getSystemInfo()
  const osType = sysInfo.os_type
  const arch = sysInfo.cpu.arch

  console.info('[listSupportedBackends] sysInfo:', osType, arch)

  const rawFeatures = await _getSupportedFeatures()
  const features = normalizeFeatures(rawFeatures)

  const supportedBackends = await determineSupportedBackends(
    osType,
    arch,
    features
  )
  console.info('[listSupportedBackends] supportedBackends:', supportedBackends)

  const [localBackendVersions, remoteBackendVersions] = await Promise.all([
    getLocalInstalledBackends(),
    fetchRemoteBackends(),
  ])
  console.info(
    '[listSupportedBackends] local backends:',
    localBackendVersions.length,
    localBackendVersions
  )
  console.info(
    '[listSupportedBackends] remote backends:',
    remoteBackendVersions.length,
    remoteBackendVersions.map((b) => `${b.version}/${b.backend}`)
  )

  return listSupportedBackendsFromRust(
    remoteBackendVersions,
    localBackendVersions
  )
}

export async function getBackendDir(
  backend: string,
  version: string
): Promise<string> {
  const janDataFolderPath = await getJanDataFolderPath()
  const backendDir = await joinPath([
    janDataFolderPath,
    'llamacpp',
    'backends',
    version,
    backend,
  ])
  return backendDir
}

export async function getBackendExePath(
  backend: string,
  version: string
): Promise<string> {
  const exe_name = IS_WINDOWS ? 'llama-server.exe' : 'llama-server'
  const backendDir = await getBackendDir(backend, version)
  let exePath: string
  const buildDir = await joinPath([backendDir, 'build'])
  if (await fs.existsSync(buildDir)) {
    exePath = await joinPath([backendDir, 'build', 'bin', exe_name])
  } else {
    exePath = await joinPath([backendDir, exe_name])
  }
  return exePath
}

export async function isBackendInstalled(
  backend: string,
  version: string
): Promise<boolean> {
  const exePath = await getBackendExePath(backend, version)
  const result = await fs.existsSync(exePath)
  return result
}

async function _getSupportedFeatures() {
  const sysInfo = await getSystemInfo()
  return await getSupportedFeaturesFromRust(
    sysInfo.os_type,
    sysInfo.cpu.extensions,
    sysInfo.gpus
  )
}
