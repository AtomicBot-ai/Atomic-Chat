import { getJanDataFolderPath, fs, joinPath } from '@janhq/core'
import { getProxyConfig } from './util'
import { getBackendCatalog, listInstalledBackends } from './adapter/coreRuntime'
import type { CoreBackendCatalog, CoreProxyConfig } from './adapter/coreRuntime'
import type { SettingUpdateResult } from '../../../src-tauri/plugins/tauri-plugin-llamacpp-upstream/guest-js/types'

// The PrismML provider runs the PrismML-Eng/llama.cpp fork. Which releases
// exist, which of them this machine can run and which one is recommended is a
// question for atomic-chat-core: `loadCatalog` below asks
// `POST /backends/atomic-prism/catalog`, and the core owns the
// `atomic-chat-conf` manifest, its offline baseline, the hardware probe and the
// candidate/approved gate. This module only knows where the packs sit on disk.

/** This provider's own tree: `<data>/atomic-prism/backends/<tag>/<backend>`. */
const PROVIDER_ROOT = 'atomic-prism'

/** `prism-b10754-2459f68` — the shape of every PrismML release tag. */
const PRISM_TAG_RE = /^prism-b(\d+)-([0-9a-f]+)$/

/**
 * The build number of a PrismML release tag (`prism-b10754-2459f68` → 10754),
 * or `null` when the string is not one.
 */
export function prismTagBuild(tag: string): number | null {
  const match = PRISM_TAG_RE.exec(tag.replace(/\uFEFF/g, '').trim())
  return match ? Number(match[1]) : null
}

/**
 * The last catalog the core answered with. Every reader in this session shares
 * it, so the core is asked once per launch unless a caller explicitly forces a
 * refresh (the "check for engine updates" button). A failed call leaves the
 * previous answer in place.
 */
let _catalog: CoreBackendCatalog | null = null

/**
 * What builds exist for this provider on this machine, as the core sees it.
 * `force` bypasses both this module's memo and the core's manifest cache, so a
 * release published while the app was open becomes visible.
 */
export async function loadCatalog(options?: {
  /** Ask the core to refetch the release stream too (a user-driven check). */
  force?: boolean
  /**
   * Ask the core again instead of answering from this module's memo, without forcing a refetch:
   * the core rescans the packs on disk (a backend installed from a file never passes through it),
   * while its own manifest cache still answers the remote half.
   */
  refresh?: boolean
  appVersion?: string | null
}): Promise<CoreBackendCatalog> {
  if (!options?.force && !options?.refresh && _catalog) return _catalog
  const catalog = await getBackendCatalog({
    force: options?.force ?? false,
    app_version: options?.appVersion ?? null,
    proxy: (getProxyConfig() as unknown as CoreProxyConfig | null) ?? null,
  })
  _catalog = catalog
  return catalog
}

/**
 * The packs on disk, as the core lists them. The core owns the data folder and
 * may have installed a pack this process never saw (for the CLI, say), so its
 * listing is the answer rather than a directory scan of our own.
 */
export async function getLocalInstalledBackends(): Promise<
  { version: string; backend: string }[]
> {
  return (await listInstalledBackends()).map(({ version, backend }) => ({
    version,
    backend,
  }))
}

export interface InstalledBackendPack {
  version: string
  backend: string
  path: string
  active: boolean
}

const clean = (value: string) => value.replace(/\uFEFF/g, '').trim()

export interface BackendOption {
  value: string
  name: string
}

/**
 * Flattens the version-dropdown tiers into one list.
 *
 * The tiers are passed most-preferred first and the first spelling of a
 * `version/backend` wins, so a build that appears in several tiers keeps its
 * richest label. `recommended` is forced into the list because a
 * recommendation the dropdown cannot offer is a dead end: the UI would mark a
 * version the user has no way to select.
 */
export function mergeBackendOptions(
  tiers: BackendOption[][],
  recommended?: BackendOption
): BackendOption[] {
  const merged: BackendOption[] = []
  const seen = new Set<string>()

  for (const tier of tiers) {
    for (const option of tier) {
      const value = clean(option.value)
      if (!value || seen.has(value)) continue
      seen.add(value)
      merged.push({ value, name: option.name })
    }
  }

  const recommendedValue = recommended ? clean(recommended.value) : ''
  if (recommendedValue && !seen.has(recommendedValue)) {
    merged.unshift({ value: recommendedValue, name: recommended!.name })
  }

  return merged
}

/**
 * A short label for a PrismML backend id (`linux-cuda-12.4-x64` → `CUDA 12.4`),
 * used by the backend dialog. Falls back to the raw id for anything
 * unrecognised.
 */
export function friendlyBackendLabel(backend: string): string {
  const id = clean(backend)
  if (id.endsWith('cpu-x64') || id.endsWith('cpu-arm64')) return 'CPU'
  const cuda = /cuda-(\d+(?:\.\d+)?)/.exec(id)
  if (cuda) return `CUDA ${cuda[1]}`
  const rocm = /rocm-(\d+(?:\.\d+)?)/.exec(id)
  if (rocm) return `ROCm ${rocm[1]}`
  if (id.includes('vulkan')) return 'Vulkan'
  if (id === 'macos-arm64') return 'Apple Silicon'
  if (id === 'macos-x64') return 'Intel'
  return id
}

/**
 * The `version` / `backend` pair a PrismML release archive installs as, read
 * off its published name (`llama-prism-b10754-2459f68-bin-macos-arm64.tar.gz`),
 * or `null` when the name is not a PrismML server archive.
 *
 * PrismML names its Linux CPU, Vulkan and ROCm builds `ubuntu-*`, while the
 * manifest and the core store them as `linux-*` (`ubuntu-x64` is the CPU build),
 * so the archive name is mapped onto the id the core looks the pack up by.
 */
export function parsePrismArchiveName(
  archiveName: string
): { version: string; backend: string } | null {
  const match =
    /^llama-(prism-b\d+-[0-9a-f]+)-bin-(.+?)\.(?:tar\.gz|zip)$/.exec(
      clean(archiveName)
    )
  if (!match) return null
  const [, version, rawBackend] = match
  if (!rawBackend.startsWith('ubuntu-')) return { version, backend: rawBackend }
  const rest = rawBackend.slice('ubuntu-'.length)
  const backend =
    rest === 'x64' || rest === 'arm64' ? `linux-cpu-${rest}` : `linux-${rest}`
  return { version, backend }
}

export async function getBackendDir(
  backend: string,
  version: string
): Promise<string> {
  const janDataFolderPath = await getJanDataFolderPath()
  return await joinPath([
    janDataFolderPath,
    PROVIDER_ROOT,
    'backends',
    clean(version),
    clean(backend),
  ])
}

async function getBackendExePath(
  backend: string,
  version: string
): Promise<string> {
  const exe_name = IS_WINDOWS ? 'llama-server.exe' : 'llama-server'
  const backendDir = await getBackendDir(backend, version)
  const buildDir = await joinPath([backendDir, 'build'])
  if (await fs.existsSync(buildDir)) {
    return await joinPath([backendDir, 'build', 'bin', exe_name])
  }
  return await joinPath([backendDir, exe_name])
}

export async function isBackendInstalled(
  backend: string,
  version: string
): Promise<boolean> {
  return await fs.existsSync(await getBackendExePath(backend, version))
}

/**
 * Remove orphan / incomplete backend directories from this provider's
 * backends tree (ATO-179). An "incomplete" directory is one that exists on
 * disk but carries no `llama-server` executable — e.g. an empty stub left by
 * an interrupted download, which would otherwise be mistaken for a usable
 * backend or block a clean re-download.
 *
 * Scoped strictly to `atomic-prism/backends/` so the shared GGUF model tree and
 * the other providers' backends are never touched. Returns the removed
 * `<version>/<backend>` identifiers.
 */
export async function cleanupIncompleteBackends(): Promise<string[]> {
  const janDataFolderPath = await getJanDataFolderPath()
  const backendsRoot = await joinPath([
    janDataFolderPath,
    PROVIDER_ROOT,
    'backends',
  ])

  const removed: string[] = []
  if (!(await fs.existsSync(backendsRoot))) return removed

  const versionDirs: string[] = await fs.readdirSync(backendsRoot)
  for (const version of versionDirs) {
    const versionPath = await joinPath([backendsRoot, version])
    let backendTypes: string[]
    try {
      backendTypes = await fs.readdirSync(versionPath)
    } catch {
      // Not a directory (stray file) — skip; it does not match our layout.
      continue
    }

    for (const backendType of backendTypes) {
      // `<backend>.incoming-<ts>` is atomic-chat-core staging an install it is running right now
      // (possibly for the CLI); it renames the folder into place when the archive is unpacked.
      if (backendType.includes('.incoming-')) continue
      if (await isBackendInstalled(backendType, version)) continue
      const dir = await getBackendDir(backendType, version)
      await fs.rm(dir)
      removed.push(`${version}/${backendType}`)
    }

    // Drop a now-empty version directory.
    try {
      const remaining: string[] = await fs.readdirSync(versionPath)
      if (remaining.length === 0) await fs.rm(versionPath)
    } catch {
      // ignore
    }
  }

  return removed
}

/**
 * What a `version_backend` setting change asks for. The value is
 * `version/backend` (a BOM left by PowerShell-generated files is stripped
 * first); the preference is reported as updated when the backend id differs
 * from the one stored (or nothing is stored). Rejects anything that is not
 * exactly two non-empty parts.
 */
export function parseVersionBackendSetting(
  value: string,
  currentStoredBackend: string | undefined
): SettingUpdateResult {
  const cleanValue = value.replace(/\uFEFF/g, '')
  const parts = cleanValue.split('/')
  if (parts.length !== 2) {
    throw new Error(`Invalid backend format: ${cleanValue}`)
  }
  const version = parts[0].trim()
  const backend = parts[1].trim()
  if (!version || !backend) {
    throw new Error(`Invalid backend format: ${value}`)
  }

  return {
    backend_type_updated:
      currentStoredBackend === undefined || currentStoredBackend !== backend,
    effective_backend_type: backend,
    needs_backend_installation: true,
    version,
    backend,
  }
}
