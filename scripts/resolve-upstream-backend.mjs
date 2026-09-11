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
// It mirrors the client's own logic in
// extensions/llamacpp-upstream-extension/src/backend.ts: the manifest in
// atomic-chat-conf is authoritative for the tag, `download_base` points at our
// signed mirror, and a tag we have not mirrored falls back to the ggml-org CDN
// without a hash.
//
// Usage:
//   node scripts/resolve-upstream-backend.mjs --backend macos-arm64
//   node scripts/resolve-upstream-backend.mjs --backend win-cuda-13-x64
//   node scripts/resolve-upstream-backend.mjs --backend linux-cpu-x64 --tag b10344
//
// `--engine sdcpp` resolves a stable-diffusion.cpp prebuilt instead, from
// backends/sdcpp-manifest.json. That manifest names every asset explicitly
// (upstream file names embed the CI runner's OS version), so the asset is
// looked up by its `backend` id, never constructed, and it prints the extra
// COMPANION/COMPANION_URL lines for builds that need a runtime archive:
//   node scripts/resolve-upstream-backend.mjs --engine sdcpp --backend win-cuda12-x64

import { pathToFileURL } from 'node:url'

const MANIFEST_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/backends/manifest.json'
const SDCPP_MANIFEST_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/backends/sdcpp-manifest.json'
const GGML_ORG_DOWNLOAD_BASE =
  'https://github.com/ggml-org/llama.cpp/releases/download'
const SDCPP_UPSTREAM_REPO = 'leejet/stable-diffusion.cpp'
/** leejet tag, optionally with the `-a<sha>` suffix of an Atomic-built variant. */
const SDCPP_TAG_RE = /^master-\d+-[0-9a-f]{7}(-a[0-9a-f]{7})?$/

// Upstream names its Linux builds `ubuntu-*`; the app's backend ids say
// `linux-*`. Keep this in step with LINUX_UPSTREAM_ASSET_BY_BACKEND in
// extensions/llamacpp-upstream-extension/src/backend.ts.
const LINUX_ASSET_INFIX = {
  'linux-cpu-x64': 'ubuntu-x64',
  'linux-vulkan-x64': 'ubuntu-vulkan-x64',
}

const WIN_CUDA_FAMILY_RE = /^win-cuda-(\d+)-x64$/

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
 * Resolves a minor-less Windows CUDA family id (`win-cuda-13-x64`) to the
 * highest concrete minor the manifest lists (`win-cuda-13.3-x64`). Upstream
 * moves the minor between releases, so it cannot be hardcoded (ATO-174).
 */
export function resolveCudaFamily(backend, tag, assetNames) {
  const family = WIN_CUDA_FAMILY_RE.exec(backend)
  if (!family) return backend
  const major = family[1]
  const re = new RegExp(
    `^llama-${tag}-bin-win-cuda-${major}\\.(\\d+)-x64\\.zip$`
  )
  let best = null
  for (const name of assetNames) {
    const match = re.exec(name)
    if (!match) continue
    const minor = Number(match[1])
    if (best === null || minor > best) best = minor
  }
  if (best === null) return null
  return `win-cuda-${major}.${best}-x64`
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

// --- stable-diffusion.cpp ----------------------------------------------------

/** `master-849-d04e895-a1b2c3d` → `master-849-d04e895`; upstream tags pass through. */
export function stripSdcppTagSuffix(tag) {
  return tag.replace(/-a[0-9a-f]{7}$/, '')
}

/** The manifest entry for a backend id, or null. Names are never constructed. */
export function sdcppAssetFor(manifest, backend) {
  return (manifest?.assets ?? []).find((a) => a.backend === backend) ?? null
}

/**
 * Where an sd.cpp asset comes from. The mirror when the manifest names one;
 * otherwise the upstream GitHub release, whose tag never carries the Atomic
 * variant suffix. The hash travels either way — the manifest records the
 * GitHub digest even before the tag is mirrored — but, as for llama.cpp, a
 * hash without a size is not trusted.
 */
export function pickSdcppSource(manifest, asset) {
  const tag = manifest.tag_name
  const url = manifest.download_base
    ? `${manifest.download_base}/${tag}/${asset.name}`
    : `https://github.com/${manifest.upstream_repo ?? SDCPP_UPSTREAM_REPO}/releases/download/${stripSdcppTagSuffix(tag)}/${asset.name}`
  if (!asset.sha256 || !asset.size) return { url }
  return { url, sha256: asset.sha256, size: asset.size }
}

async function resolveSdcpp(args) {
  const backend = args.backend
  const pinned = args.tag
  if (pinned && !SDCPP_TAG_RE.test(pinned)) {
    die(`--tag must look like a leejet release tag (got "${pinned}")`)
  }
  process.stderr.write(
    'Resolving sd.cpp backend from the atomic-chat-conf manifest...\n'
  )
  const manifest = await fetchManifest(SDCPP_MANIFEST_URL)
  if (pinned && manifest.tag_name !== pinned) {
    // Asset names come from the manifest, so an unmirrored tag has no answer.
    die(
      `manifest is at ${manifest.tag_name}, not ${pinned}; sd.cpp assets can only be resolved for the manifest tag`
    )
  }
  const asset = sdcppAssetFor(manifest, backend)
  if (!asset || asset.companion) {
    die(
      `manifest tag ${manifest.tag_name} lists no backend "${backend}" (update atomic-chat-conf/backends/sdcpp-manifest.json)`
    )
  }
  const source = pickSdcppSource(manifest, asset)
  if (source.sha256) {
    process.stderr.write('sha256 will be verified\n')
  } else {
    process.stderr.write('No hash in the manifest; downloading unverified\n')
  }

  // Only the Windows CUDA build needs a runtime archive beside it.
  const companion =
    backend === 'win-cuda12-x64' ? sdcppAssetFor(manifest, 'win-cudart-cu12') : null

  process.stdout.write(
    [
      `TAG=${manifest.tag_name}`,
      `BACKEND=${backend}`,
      `ASSET=${asset.name}`,
      `URL=${source.url}`,
      `SHA256=${source.sha256 ?? ''}`,
      `SIZE=${source.size ?? ''}`,
      `COMPANION=${companion?.name ?? ''}`,
      `COMPANION_URL=${companion ? pickSdcppSource(manifest, companion).url : ''}`,
      '',
    ].join('\n')
  )
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const backend = args.backend
  if (!backend) {
    process.stderr.write(
      'usage: resolve-upstream-backend.mjs [--engine llama|sdcpp] --backend <id> [--tag <pin>]\n'
    )
    process.exit(2)
  }

  const engine = args.engine ?? 'llama'
  if (engine === 'sdcpp') {
    await resolveSdcpp(args)
    return
  }
  if (engine !== 'llama') {
    die(`--engine must be llama or sdcpp (got "${engine}")`)
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

  let manifest = null
  if (pinned) {
    process.stderr.write(`Using pinned upstream release: ${pinned}\n`)
  } else {
    process.stderr.write(
      'Resolving backend index from the atomic-chat-conf manifest (ATO-199)...\n'
    )
    manifest = await fetchManifest()
  }

  const tag = pinned ?? manifest.tag_name
  const assetNames = (manifest?.assets ?? []).map((a) => a.name)

  let resolvedBackend = backend
  if (WIN_CUDA_FAMILY_RE.test(backend)) {
    resolvedBackend = resolveCudaFamily(backend, tag, assetNames)
    if (!resolvedBackend) {
      die(
        `manifest tag ${tag} lists no concrete asset for the CUDA family "${backend}" (update atomic-chat-conf/backends/manifest.json)`
      )
    }
    process.stderr.write(`Resolved ${backend} -> ${resolvedBackend}\n`)
  }

  const asset = assetNameFor(tag, resolvedBackend)
  if (manifest && !assetNames.includes(asset)) {
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
