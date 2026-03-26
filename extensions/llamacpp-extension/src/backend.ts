import { getJanDataFolderPath, fs, joinPath, events } from '@janhq/core'
import { invoke } from '@tauri-apps/api/core'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { getProxyConfig, basenameNoExt } from './util'
import { dirname } from '@tauri-apps/api/path'
import { getSystemInfo } from '@janhq/tauri-plugin-hardware-api'
import {
  mapOldBackendToNew,
  getLocalInstalledBackendsInternal,
  normalizeFeatures,
  determineSupportedBackends,
  listSupportedBackendsFromRust,
  BackendVersion,
  getSupportedFeaturesFromRust,
  isCudaInstalledFromRust,
} from '@janhq/tauri-plugin-llamacpp-api'

/*
 * Reads currently installed backends in janDataFolderPath
 *
 */
export async function getLocalInstalledBackends(): Promise<
  { version: string; backend: string }[]
> {
  const janDataFolderPath = await getJanDataFolderPath()
  const backendDir = await joinPath([
    janDataFolderPath,
    'llamacpp',
    'backends',
  ])
  return await getLocalInstalledBackendsInternal(backendDir)
}
/*
 * currently reads available backends in remote
 *
 */
async function fetchRemoteSupportedBackends(
  supportedBackends: string[]
): Promise<{ version: string; backend: string }[]> {
  const { releases } = await _fetchGithubReleases('Vect0rM', 'atomic-llama-cpp-turboquant')
  releases.sort((a, b) => b.tag_name.localeCompare(a.tag_name))
  releases.splice(10)

  const remote: { version: string; backend: string }[] = []
  const TURBOQUANT_PREFIX = 'llama-turboquant-'

  for (const release of releases) {
    const version = release.tag_name

    for (const asset of release.assets) {
      const name: string = asset.name

      // Turboquant assets: llama-turboquant-{backend}.tar.gz
      if (name.startsWith(TURBOQUANT_PREFIX)) {
        const backend = basenameNoExt(name).slice(TURBOQUANT_PREFIX.length)
        if (supportedBackends.includes(backend)) {
          remote.push({ version, backend })
          continue
        }
        const mappedNew = await mapOldBackendToNew(backend)
        if (mappedNew !== backend && supportedBackends.includes(mappedNew)) {
          remote.push({ version, backend })
        }
        continue
      }

      // Legacy assets: llama-{version}-bin-{backend}.tar.gz
      const legacyPrefix = `llama-${version}-bin-`
      if (name.startsWith(legacyPrefix)) {
        const backend = basenameNoExt(name).slice(legacyPrefix.length)
        if (supportedBackends.includes(backend)) {
          remote.push({ version, backend })
          continue
        }
        const mappedNew = await mapOldBackendToNew(backend)
        if (mappedNew !== backend && supportedBackends.includes(mappedNew)) {
          remote.push({ version, backend })
        }
      }
    }
  }

  return remote
}

// folder structure
// <Jan's data folder>/llamacpp/backends/<backend_version>/<backend_type>

// what should be available to the user for selection?
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

  let remoteBackendVersions: BackendVersion[] = []
  try {
    console.info('[listSupportedBackends] fetching remote backends...')
    const REMOTE_TIMEOUT_MS = 10_000
    remoteBackendVersions = await Promise.race([
      fetchRemoteSupportedBackends(supportedBackends),
      new Promise<BackendVersion[]>((_, reject) =>
        setTimeout(
          () => reject(new Error(`remote fetch timed out after ${REMOTE_TIMEOUT_MS}ms`)),
          REMOTE_TIMEOUT_MS
        )
      ),
    ])
    console.info(
      '[listSupportedBackends] remote backends:',
      remoteBackendVersions.length
    )
  } catch (e) {
    console.warn(
      `[listSupportedBackends] remote fetch failed (will use local): ${String(e)}`
    )
  }

  const localBackendVersions = await getLocalInstalledBackends()
  console.info(
    '[listSupportedBackends] local backends:',
    localBackendVersions.length,
    localBackendVersions
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

export async function downloadBackend(
  backend: string,
  version: string,
): Promise<void> {
  const backendDir = await getBackendDir(backend, version)

  const downloadManager = window.core.extensionManager.getByName(
    '@janhq/download-extension'
  )

  // Get proxy configuration from localStorage
  const proxyConfig = getProxyConfig()

  const platformName = IS_WINDOWS ? 'win' : 'linux'

  // Turboquant releases use "llama-turboquant-{backend}" naming;
  // fall back to legacy "{version}-bin-{backend}" for older tags.
  const isTurboquantRelease = version.startsWith('turboquant-')
  const assetName = isTurboquantRelease
    ? `llama-turboquant-${backend}.tar.gz`
    : `llama-${version}-bin-${backend}.tar.gz`
  const backendUrl =
    `https://github.com/Vect0rM/atomic-llama-cpp-turboquant/releases/download/${version}/${assetName}`

  const taskId = `llamacpp-${version}-${backend}`.replace(/\./g, '-')

  const downloadItems = [
    {
      url: backendUrl,
      save_path: await joinPath([backendDir, 'backend.tar.gz']),
      proxy: proxyConfig,
      model_id: taskId,
    },
  ]

  // also download CUDA runtime + cuBLAS + cuBLASLt if needed
  if (
    (backend.includes('cu11.7') || backend.includes('cuda-11')) &&
    !(await _isCudaInstalled(backendDir, '11.7'))
  ) {
    downloadItems.push({
      url:
        `https://github.com/Vect0rM/atomic-llama-cpp-turboquant/releases/download/${version}/cudart-llama-bin-${platformName}-cu11.7-x64.tar.gz`,
      save_path: await joinPath([backendDir, 'build', 'bin', 'cuda11.tar.gz']),
      proxy: proxyConfig,
      model_id: taskId,
    })
  } else if (
    (backend.includes('cu12.0') || backend.includes('cuda-12')) &&
    !(await _isCudaInstalled(backendDir, '12.0'))
  ) {
    downloadItems.push({
      url:
        `https://github.com/Vect0rM/atomic-llama-cpp-turboquant/releases/download/${version}/cudart-llama-bin-${platformName}-cu12.0-x64.tar.gz`,
      save_path: await joinPath([backendDir, 'build', 'bin', 'cuda12.tar.gz']),
      proxy: proxyConfig,
      model_id: taskId,
    })
  } else if (
    backend.includes('cuda-13') &&
    !(await _isCudaInstalled(backendDir, '13.0'))
  ) {
    downloadItems.push({
      url:
        `https://github.com/Vect0rM/atomic-llama-cpp-turboquant/releases/download/${version}/cudart-llama-bin-${platformName}-cu13.0-x64.tar.gz`,
      save_path: await joinPath([backendDir, 'build', 'bin', 'cuda13.tar.gz']),
      proxy: proxyConfig,
      model_id: taskId,
    })
  }
  const downloadType = 'Engine'

  console.log(
    `Downloading backend ${backend} version ${version}: ${JSON.stringify(
      downloadItems
    )}`
  )
  let downloadCompleted = false
  try {
    const onProgress = (transferred: number, total: number) => {
      events.emit('onFileDownloadUpdate', {
        modelId: taskId,
        percent: transferred / total,
        size: { transferred, total },
        downloadType,
      })
      downloadCompleted = transferred === total
    }
    await downloadManager.downloadFiles(downloadItems, taskId, onProgress)

    // once we reach this point, it either means download finishes or it was cancelled.
    // if there was an error, it would have been caught above
    if (!downloadCompleted) {
      events.emit('onFileDownloadStopped', { modelId: taskId, downloadType })
      return
    }

    // decompress the downloaded tar.gz files
    for (const { save_path } of downloadItems) {
      if (save_path.endsWith('.tar.gz')) {
        const parentDir = await dirname(save_path)
        await invoke('decompress', { path: save_path, outputDir: parentDir })
        await fs.rm(save_path)
      }
    }

    // Legacy tarballs may extract to llama-{version}/ flat structure.
    // The app expects build/bin/llama-server — rearrange if needed.
    // Turboquant tarballs already extract to build/bin/, so this is a no-op for them.
    const extractedDir = await joinPath([backendDir, `llama-${version}`])
    if (await fs.existsSync(extractedDir)) {
      const buildDir = await joinPath([backendDir, 'build'])
      await fs.mkdir(buildDir)
      const buildBinDir = await joinPath([buildDir, 'bin'])
      await fs.mv(extractedDir, buildBinDir)
    }

    events.emit('onFileDownloadSuccess', { modelId: taskId, downloadType })
  } catch (error) {
    console.error(`Failed to download backend ${backend}: `, error)
    events.emit('onFileDownloadError', { modelId: taskId, downloadType })
    throw error
  }
}

async function _getSupportedFeatures() {
  const sysInfo = await getSystemInfo()
  return await getSupportedFeaturesFromRust(
    sysInfo.os_type,
    sysInfo.cpu.extensions,
    sysInfo.gpus
  )
}

/**
 * Fetch releases from GitHub with timeout and optional proxy passthrough.
 */
async function _fetchGithubReleases(
  owner: string,
  repo: string
): Promise<{ releases: any[] }> {
  const githubUrl = `https://api.github.com/repos/${owner}/${repo}/releases`

  const proxyConfig = getProxyConfig()
  const fetchInit: Record<string, unknown> = {
    connectTimeout: 15_000,
  }
  if (proxyConfig?.url) {
    fetchInit.proxy = { all: { url: proxyConfig.url } }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20_000)
  fetchInit.signal = controller.signal

  try {
    const response = await tauriFetch(githubUrl, fetchInit as any)
    if (!response.ok)
      throw new Error(
        `GitHub error: ${response.status} ${response.statusText}`
      )
    const releases = await response.json()
    return { releases }
  } finally {
    clearTimeout(timeout)
  }
}

// accept backendDir (full path) and cuda version (e.g. '11.7' or '12.0' or '13.0')
async function _isCudaInstalled(
  backendDir: string,
  version: string
): Promise<boolean> {
  const sysInfo = await getSystemInfo()
  const janDataFolderPath = await getJanDataFolderPath()

  return isCudaInstalledFromRust(
    backendDir,
    version,
    sysInfo.os_type,
    janDataFolderPath
  )
}
