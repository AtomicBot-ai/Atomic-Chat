#!/usr/bin/env node
// Resolve which upstream llama.cpp archive the bundled backend should be built
// from, and print it as shell-friendly KEY=value lines on stdout:
//
//   TAG=b10405
//   BACKEND=win-cuda-13.3-x64
//   ASSET=llama-b10405-bin-win-cuda-13.3-x64.zip
//   URL=https://github.com/AtomicBot-ai/atomic-chat-conf/releases/download/...
//   SHA256=<64 hex, empty when the tag was not mirrored>
//   SIZE=<bytes, empty when the tag was not mirrored>
//
// Diagnostics go to stderr; any ambiguity is a non-zero exit.
//
// This exists because the same resolution used to be copy-pasted as jq
// one-liners into three Makefile branches, a PowerShell branch and the Windows
// release job — and every one of them hardcoded the ggml-org download base.
// Node (unlike a make recipe) reads the same from bash, pwsh and make.
//
// It picks what the pinned core would offer on its own: the release list in
// atomic-chat-conf (backends/llamacpp-upstream-releases.json), newest release
// first, takes the first one that is not withdrawn, whose `min_core_version`
// the pinned core (package.json `atomicCore.version`) meets and whose archive
// for this backend is approved. The installer and the runtime catalog then
// start on the same build. `download_base` points at our signed mirror; every
// listed tag, a pinned one included, downloads against its hash. When conf has
// no release list yet (404, or a schema this script does not read) the legacy
// backends/manifest.json decides, as it did before; a tag in neither falls
// back to the ggml-org CDN without a hash.
//
// Usage:
//   node scripts/resolve-upstream-backend.mjs --backend macos-arm64
//   node scripts/resolve-upstream-backend.mjs --backend win-cuda-13-x64
//   node scripts/resolve-upstream-backend.mjs --backend linux-cpu-x64 --tag b10344
//   node scripts/resolve-upstream-backend.mjs --backend macos-arm64 \
//     --releases-from ../atomic-chat-conf/backends/llamacpp-upstream-releases.json \
//     --core-version 0.15.0

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const RELEASES_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/backends/llamacpp-upstream-releases.json'
const MANIFEST_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/backends/manifest.json'
const GGML_ORG_DOWNLOAD_BASE =
  'https://github.com/ggml-org/llama.cpp/releases/download'

// Upstream names its Linux builds `ubuntu-*`; the app's backend ids say
// `linux-*`. Keep this in step with LINUX_UPSTREAM_ASSET_BY_BACKEND in
// extensions/llamacpp-upstream-extension/src/backend.ts.
const LINUX_ASSET_INFIX = {
  'linux-cpu-x64': 'ubuntu-x64',
  'linux-vulkan-x64': 'ubuntu-vulkan-x64',
  'linux-cpu-arm64': 'ubuntu-arm64',
  'linux-vulkan-arm64': 'ubuntu-vulkan-arm64',
}

const WIN_CUDA_FAMILY_RE = /^win-cuda-(\d+)-(x64|arm64)$/

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    out[argv[i].slice(2)] = argv[i + 1]
    i++
  }
  return out
}

function die(message) {
  process.stderr.write(`Error: ${message}\n`)
  process.exit(1)
}

export function assetNameFor(tag, backend) {
  const infix = LINUX_ASSET_INFIX[backend]
  if (infix) return `llama-${tag}-bin-${infix}.tar.gz`
  const extension = backend.startsWith('macos-') ? 'tar.gz' : 'zip'
  return `llama-${tag}-bin-${backend}.${extension}`
}

/**
 * Resolves a minor-less Windows CUDA family id (`win-cuda-13-x64`,
 * `win-cuda-13-arm64`) to the highest concrete minor the manifest lists for
 * that arch (`win-cuda-13.3-x64`). Upstream moves the minor between releases,
 * so it cannot be hardcoded (ATO-174).
 */
export function resolveCudaFamily(backend, tag, assetNames) {
  const family = WIN_CUDA_FAMILY_RE.exec(backend)
  if (!family) return backend
  const [, major, arch] = family
  const re = new RegExp(
    `^llama-${tag}-bin-win-cuda-${major}\\.(\\d+)-${arch}\\.zip$`
  )
  let best = null
  for (const name of assetNames) {
    const match = re.exec(name)
    if (!match) continue
    const minor = Number(match[1])
    if (best === null || minor > best) best = minor
  }
  if (best === null) return null
  return `win-cuda-${major}.${best}-${arch}`
}

/**
 * Picks the download source for one asset. The mirror is used only when the
 * manifest describes this exact tag and lists this exact asset with a hash;
 * everything else resolves to the upstream CDN unverified, which is what the
 * build did before the mirror existed.
 */
export function pickSource(manifest, tag, asset) {
  const fallback = { url: `${GGML_ORG_DOWNLOAD_BASE}/${tag}/${asset}` }
  if (!manifest || manifest.tag_name !== tag || !manifest.download_base) {
    return fallback
  }
  const entry = (manifest.assets ?? []).find((a) => a.name === asset)
  if (!entry?.sha256 || !entry.size) return fallback
  return {
    url: `${manifest.download_base}/${tag}/${asset}`,
    sha256: entry.sha256,
    size: entry.size,
  }
}

/** Dotted-numeric comparison, as the core's `compareVersions`. Returns -1, 0 or 1. */
export function compareVersions(a, b) {
  const pa = String(a).split('.')
  const pb = String(b).split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number(pa[i] ?? 0) || 0
    const y = Number(pb[i] ?? 0) || 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

const buildOf = (tag) => Number(/^b(\d+)$/.exec(tag ?? '')?.[1] ?? 0)

/**
 * One listed release in the legacy manifest's shape, for pickSource: any
 * listed tag downloads from the mirror against its hash. `null` when the tag
 * is not listed.
 */
export function manifestForTag(list, tag) {
  const release = (list?.releases ?? []).find((r) => r.tag === tag)
  if (!release) return null
  return {
    tag_name: release.tag,
    download_base: list.download_base,
    assets: (release.assets ?? []).map(({ name, sha256, size }) => ({ name, sha256, size })),
  }
}

/**
 * The release the pinned core would take for this backend: newest first, not
 * withdrawn, `min_core_version` met, the backend's archive approved and
 * hashed. A CUDA family id resolves against that release's approved archives.
 * Returns `{ tag, backend }` with the concrete backend id, or `null`.
 */
export function pickRelease(list, { coreVersion, backend }) {
  const releases = [...(list?.releases ?? [])].sort((a, b) => buildOf(b.tag) - buildOf(a.tag))
  for (const release of releases) {
    if (release.withdrawn) continue
    if (compareVersions(coreVersion, release.min_core_version ?? '0.0.0') < 0) continue
    const names = (release.assets ?? [])
      .filter((a) => a.validation === 'approved' && a.sha256 && a.size)
      .map((a) => a.name)
    const concrete = WIN_CUDA_FAMILY_RE.test(backend)
      ? resolveCudaFamily(backend, release.tag, names)
      : backend
    if (concrete && names.includes(assetNameFor(release.tag, concrete))) {
      return { tag: release.tag, backend: concrete }
    }
  }
  return null
}

/**
 * The release list, or `null` when conf does not publish one this script can
 * read (a 404 before it did, another schema). A network failure is fatal: a
 * build must not silently fall back to an older rule.
 */
async function fetchReleases(from) {
  if (from) return JSON.parse(readFileSync(from, 'utf8'))
  const resp = await fetch(RELEASES_URL, {
    headers: { 'User-Agent': 'atomic-chat-ci', 'Accept': 'application/json' },
  })
  if (!resp.ok) {
    process.stderr.write(`Release list returned HTTP ${resp.status}; using the legacy manifest\n`)
    return null
  }
  let list
  try {
    list = await resp.json()
  } catch {
    process.stderr.write('Release list is not valid JSON; using the legacy manifest\n')
    return null
  }
  if (list?.schema_version !== 1 || !Array.isArray(list.releases)) {
    process.stderr.write('Release list has a schema this script does not read; using the legacy manifest\n')
    return null
  }
  return list
}

function pinnedCoreVersion() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const version = pkg.atomicCore?.version
  if (!version) die('package.json has no atomicCore.version')
  return version
}

async function fetchManifest(url = MANIFEST_URL) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'atomic-chat-ci', 'Accept': 'application/json' },
  })
  if (!resp.ok) {
    die(`backend manifest returned HTTP ${resp.status} from ${url}`)
  }
  let manifest
  try {
    manifest = await resp.json()
  } catch {
    die(`backend manifest at ${url} is not valid JSON`)
  }
  if (typeof manifest.tag_name !== 'string' || !manifest.tag_name) {
    die(`backend manifest at ${url} has no tag_name`)
  }
  return manifest
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const backend = args.backend
  if (!backend) {
    process.stderr.write(
      'usage: resolve-upstream-backend.mjs --backend <id> [--tag <pin>] [--core-version x.y.z] [--releases-from <file>]\n'
    )
    process.exit(2)
  }

  const pinned = args.tag
  if (pinned && !/^b\d+$/.test(pinned)) {
    die(`--tag must look like a ggml-org release tag (got "${pinned}")`)
  }
  if (pinned && WIN_CUDA_FAMILY_RE.test(backend)) {
    // The concrete minor is a property of the release, so a pinned tag plus a
    // minor-less family id has no single answer.
    die(
      `--tag cannot be combined with the minor-less family id "${backend}"; pass a concrete id such as win-cuda-13.3-x64`
    )
  }

  const list = await fetchReleases(args['releases-from'])
  let manifest = null
  let picked = null
  if (pinned) {
    process.stderr.write(`Using pinned upstream release: ${pinned}\n`)
    // Listed: from the mirror against its hash. Anything else: the CDN, as before.
    manifest = manifestForTag(list, pinned)
  } else if (list) {
    const coreVersion = args['core-version'] ?? pinnedCoreVersion()
    picked = pickRelease(list, { coreVersion, backend })
    if (!picked) {
      die(
        `no approved release in the release list carries ${backend} for core ${coreVersion} (approve one in atomic-chat-conf/backends/llamacpp-upstream-releases.json)`
      )
    }
    process.stderr.write(`Release list: ${picked.tag} is the newest approved ${picked.backend} for core ${coreVersion}\n`)
    manifest = manifestForTag(list, picked.tag)
  } else {
    process.stderr.write(
      'Resolving backend index from the atomic-chat-conf manifest (ATO-199)...\n'
    )
    manifest = await fetchManifest()
  }

  const tag = pinned ?? manifest.tag_name
  const assetNames = (manifest?.assets ?? []).map((a) => a.name)

  // pickRelease already resolved a CUDA family against approved archives only.
  let resolvedBackend = picked?.backend ?? backend
  if (!picked && WIN_CUDA_FAMILY_RE.test(backend)) {
    resolvedBackend = resolveCudaFamily(backend, tag, assetNames)
    if (!resolvedBackend) {
      die(
        `manifest tag ${tag} lists no concrete asset for the CUDA family "${backend}" (update atomic-chat-conf/backends/manifest.json)`
      )
    }
    process.stderr.write(`Resolved ${backend} -> ${resolvedBackend}\n`)
  }

  const asset = assetNameFor(tag, resolvedBackend)
  if (!pinned && manifest && !assetNames.includes(asset)) {
    die(
      `manifest tag ${tag} does not list ${asset} (update atomic-chat-conf/backends/manifest.json)`
    )
  }

  const source = pickSource(manifest, tag, asset)
  if (source.sha256) {
    process.stderr.write(`Mirrored asset, sha256 will be verified\n`)
  } else {
    process.stderr.write(
      `Not mirrored for ${tag}; downloading from the upstream CDN without a hash\n`
    )
  }

  process.stdout.write(
    [
      `TAG=${tag}`,
      `BACKEND=${resolvedBackend}`,
      `ASSET=${asset}`,
      `URL=${source.url}`,
      `SHA256=${source.sha256 ?? ''}`,
      `SIZE=${source.size ?? ''}`,
      '',
    ].join('\n')
  )
}

// Importable for unit tests; only the CLI path performs I/O.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => die(err.message))
}
