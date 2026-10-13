#!/usr/bin/env node
// Put the `mlx-server` that conf's `backends/mlx-manifest.json` pins into
// src-tauri/resources/bin, for the macOS installer.
//
// The manifest names the AtomicBot-ai/mlx-vlm release, its archive, the
// archive's sha256 and size, and the release date. The archive is checked
// against both before it is unpacked: a mismatch fails the build and leaves
// resources/bin as it was. Beside the binary goes `mlx-server.json`
// `{tag, published_at}`, which the core reads to order the installer's build
// against the ones it downloads itself (core `readBundledMlx`). The Makefile
// signs the binary afterwards; its hash in the installer then differs from the
// manifest's, which is expected (design D8).
//
// Usage:
//   node scripts/fetch-mlx-server.mjs                          # conf main's manifest
//   node scripts/fetch-mlx-server.mjs --manifest ../atomic-chat-conf/backends/mlx-manifest.json
//   node scripts/fetch-mlx-server.mjs --if-changed             # keep a build of the manifest's tag
//
// Exit 0 with `UPDATED=1` or `UPDATED=0` on stdout, so the Makefile signs only
// what it fetched; diagnostics go to stderr.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_MANIFEST =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/backends/mlx-manifest.json'
const DEFAULT_BIN_DIR = join(ROOT, 'src-tauri/resources/bin')
const BINARY = 'mlx-server'
const METADATA = 'mlx-server.json'
/** What the installer carried before the manifest: replaced by `mlx-server.json`. */
const LEGACY_FILES = ['mlx-server-version.txt', 'mlx-server-backend.txt']

// The rules of conf's `backends/mlx-schema.json`.
const TAG_RE = /^mlxvlm-macos-arm64-[0-9a-f]{7,40}$/
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const NAME_RE = /^[A-Za-z0-9._-]+\.tar\.gz$/
const SHA256_RE = /^[0-9a-f]{64}$/
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

/** The parts of the manifest the build uses, or throw why it does not pin one build. */
export function parseMlxManifest(data) {
  if (typeof data !== 'object' || data === null) throw new Error('the MLX manifest is not an object')
  if (typeof data.tag_name !== 'string' || !TAG_RE.test(data.tag_name))
    throw new Error(`the MLX manifest has no valid tag_name (${JSON.stringify(data.tag_name)})`)
  if (typeof data.upstream_repo !== 'string' || !REPO_RE.test(data.upstream_repo))
    throw new Error(`the MLX manifest has no valid upstream_repo (${JSON.stringify(data.upstream_repo)})`)
  if (typeof data.published_at !== 'string' || !DATE_TIME_RE.test(data.published_at) || Number.isNaN(Date.parse(data.published_at)))
    throw new Error(`the MLX manifest has no valid published_at (${JSON.stringify(data.published_at)})`)
  const assets = Array.isArray(data.assets) ? data.assets.filter((a) => a?.backend === 'macos-arm64') : []
  if (assets.length !== 1) throw new Error('the MLX manifest must list exactly one macos-arm64 asset')
  const [asset] = assets
  if (typeof asset.name !== 'string' || !NAME_RE.test(asset.name))
    throw new Error(`the MLX asset has no valid name (${JSON.stringify(asset.name)})`)
  if (typeof asset.sha256 !== 'string' || !SHA256_RE.test(asset.sha256))
    throw new Error('the MLX asset has no sha256: the build will not ship an unpinned binary')
  if (!Number.isInteger(asset.size) || asset.size <= 0)
    throw new Error('the MLX asset has no size: the build will not ship an unpinned binary')
  return {
    upstream_repo: data.upstream_repo,
    tag: data.tag_name,
    published_at: data.published_at,
    asset: { name: asset.name, sha256: asset.sha256, size: asset.size },
  }
}

export function mlxAssetUrl(manifest) {
  return `https://github.com/${manifest.upstream_repo}/releases/download/${manifest.tag}/${manifest.asset.name}`
}

/** True when `binDir` already holds a binary recorded as the manifest's tag. */
export function isCurrent(binDir, manifest) {
  if (!existsSync(join(binDir, BINARY))) return false
  try {
    return JSON.parse(readFileSync(join(binDir, METADATA), 'utf8'))?.tag === manifest.tag
  } catch {
    return false
  }
}

function verify(archivePath, asset) {
  const size = statSync(archivePath).size
  if (size !== asset.size)
    throw new Error(`${asset.name} is ${size} bytes, the manifest says ${asset.size}: size mismatch, nothing installed`)
  const sha256 = createHash('sha256').update(readFileSync(archivePath)).digest('hex')
  if (sha256 !== asset.sha256)
    throw new Error(`${asset.name} has sha256 ${sha256}, the manifest says ${asset.sha256}: nothing installed`)
}

/**
 * Check the archive, unpack it beside `binDir`, then move the binary in and
 * write its metadata. A failure before the move leaves `binDir` untouched.
 */
export function installArchive({ archivePath, binDir, manifest }) {
  verify(archivePath, manifest.asset)
  mkdirSync(binDir, { recursive: true })
  const staging = join(binDir, `.mlx-server-incoming-${process.pid}`)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging)
  try {
    execFileSync('tar', ['-xzf', archivePath, '-C', staging])
    const unpacked = join(staging, BINARY)
    if (!existsSync(unpacked)) throw new Error(`${manifest.asset.name} holds no ${BINARY} at its top level`)
    renameSync(unpacked, join(binDir, BINARY))
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  writeFileSync(
    join(binDir, METADATA),
    `${JSON.stringify({ tag: manifest.tag, published_at: manifest.published_at }, null, 2)}\n`
  )
  for (const legacy of LEGACY_FILES) rmSync(join(binDir, legacy), { force: true })
}

async function readManifest(source) {
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source, { headers: { Accept: 'application/json', 'User-Agent': 'atomic-chat-build' } })
    if (!response.ok) throw new Error(`the MLX manifest returned HTTP ${response.status} from ${source}`)
    return response.json()
  }
  const path = source.startsWith('file://') ? fileURLToPath(source) : resolve(source)
  return JSON.parse(readFileSync(path, 'utf8'))
}

async function download(url, dest) {
  const response = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'atomic-chat-build' } })
  if (!response.ok || !response.body) throw new Error(`GET ${url} failed with HTTP ${response.status}`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(dest))
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) out[argv[i].slice(2)] = true
    else out[argv[i++].slice(2)] = next
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const source = typeof args.manifest === 'string' && args.manifest ? args.manifest : DEFAULT_MANIFEST
  const binDir = typeof args['bin-dir'] === 'string' ? resolve(args['bin-dir']) : DEFAULT_BIN_DIR
  const manifest = parseMlxManifest(await readManifest(source))
  process.stderr.write(`MLX manifest: ${manifest.tag} (${manifest.published_at}) from ${source}\n`)
  if (args['if-changed'] && isCurrent(binDir, manifest)) {
    process.stderr.write(`mlx-server is up to date (${manifest.tag})\n`)
    process.stdout.write('UPDATED=0\n')
    return
  }
  const url = mlxAssetUrl(manifest)
  const archivePath = join(tmpdir(), `${manifest.tag}-${process.pid}.tar.gz`)
  try {
    process.stderr.write(`Downloading ${url}\n`)
    await download(url, archivePath)
    installArchive({ archivePath, binDir, manifest })
  } finally {
    rmSync(archivePath, { force: true })
  }
  process.stderr.write(`mlx-server ${manifest.tag} verified (sha256, size) and installed in ${binDir}\n`)
  process.stdout.write('UPDATED=1\n')
}

// Importable for unit tests; only the CLI path performs I/O.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`Error: ${error.message}\n`)
    process.exit(1)
  })
}
