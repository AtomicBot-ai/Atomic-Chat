// Fetch the compiled `atomic-chat-core` binary this app version is pinned to.
//
// The core is built and released from its own repository (`atomic-chat-core`), which publishes one
// binary per target plus a `SHA256SUMS` file. This script downloads what the current platform
// needs, verifies it against that file, and leaves it at
// `src-tauri/resources/bin/atomic-chat-core[.exe]`, where `make build-cli` copies it to `jan-cli`
// and signs it. On macOS both architectures are fetched and `lipo`'d into one universal binary, so
// the same .app runs on Apple silicon and Intel.
//
//   node scripts/download-core.mjs                 # the version pinned in package.json
//   node scripts/download-core.mjs --version 0.2.0 # an explicit one
//   ATOMIC_CORE_LOCAL=/path/to/binary node scripts/download-core.mjs   # use a local build instead
//
// `SKIP_BINARIES=1` skips it, matching `download-bin.mjs`.
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const BIN_DIR = path.join(ROOT, 'src-tauri/resources/bin')
const CACHE_DIR = path.join(ROOT, 'scripts/dist/core')

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const CONFIG = pkg.atomicCore ?? {}
const argVersion = process.argv.indexOf('--version')
const VERSION = argVersion > -1 ? process.argv[argVersion + 1] : (CONFIG.version ?? '')
const REPO = CONFIG.repo ?? 'AtomicBot-ai/atomic-chat-core'
const BASE = CONFIG.baseUrl ?? `https://github.com/${REPO}/releases/download/v${VERSION}`

/** Targets per platform. macOS takes both and merges them. */
function targetsFor(platform, arch) {
  if (platform === 'darwin') return ['aarch64-apple-darwin', 'x86_64-apple-darwin']
  if (platform === 'win32') return ['x86_64-pc-windows-msvc.exe']
  if (platform === 'linux') return [arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu']
  throw new Error(`Unsupported platform: ${platform}`)
}

const outputName = () => (process.platform === 'win32' ? 'atomic-chat-core.exe' : 'atomic-chat-core')

async function download(url, dest) {
  console.log(`Downloading ${url}`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`GET ${url} failed with status ${res.status}`)
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

/** `SHA256SUMS` in coreutils format: `<hex>  <name>`. */
function parseChecksums(text) {
  const map = new Map()
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim())
    if (match) map.set(match[2], match[1])
  }
  return map
}

function lipo(inputs, output) {
  const result = spawnSync('lipo', ['-create', ...inputs, '-output', output], { stdio: 'inherit' })
  if (result.status !== 0) throw new Error('lipo failed to build the universal binary')
}

async function main() {
  if (process.env.SKIP_BINARIES) {
    console.log('Skipping atomic-chat-core download.')
    return
  }
  mkdirSync(BIN_DIR, { recursive: true })
  const output = path.join(BIN_DIR, outputName())

  // A local build wins, so the app can be run against an unreleased core during development.
  const local = process.env.ATOMIC_CORE_LOCAL
  if (local) {
    if (!existsSync(local)) throw new Error(`ATOMIC_CORE_LOCAL points at ${local}, which does not exist`)
    copyFileSync(local, output)
    if (process.platform !== 'win32') chmodSync(output, 0o755)
    console.log(`Using local core build: ${local} -> ${output}`)
    return
  }

  if (!VERSION) {
    throw new Error('No core version: set `atomicCore.version` in package.json or pass --version')
  }
  mkdirSync(CACHE_DIR, { recursive: true })

  const sumsPath = path.join(CACHE_DIR, `SHA256SUMS-${VERSION}`)
  if (!existsSync(sumsPath)) await download(`${BASE}/SHA256SUMS`, sumsPath)
  const checksums = parseChecksums(readFileSync(sumsPath, 'utf8'))

  const downloaded = []
  for (const triple of targetsFor(process.platform, os.arch())) {
    const asset = `atomic-chat-core-${VERSION}-${triple}`
    const cached = path.join(CACHE_DIR, asset)
    if (!existsSync(cached)) await download(`${BASE}/${asset}`, cached)

    const expected = checksums.get(asset)
    if (!expected) throw new Error(`${asset} is not listed in SHA256SUMS — refusing to ship it`)
    const actual = sha256(cached)
    if (actual !== expected) {
      throw new Error(`${asset} failed its checksum:\n  expected ${expected}\n  actual   ${actual}`)
    }
    console.log(`Verified ${asset}`)
    downloaded.push(cached)
  }

  if (process.platform === 'darwin' && downloaded.length > 1) {
    lipo(downloaded, output)
    console.log(`Built a universal binary at ${output}`)
  } else {
    copyFileSync(downloaded[0], output)
  }
  if (process.platform !== 'win32') chmodSync(output, 0o755)

  // Record what is on disk so `make build-cli` and a developer can tell at a glance.
  writeFileSync(path.join(BIN_DIR, 'atomic-chat-core-version.txt'), `${VERSION}\n`)
  console.log(`atomic-chat-core ${VERSION} ready at ${output}`)
}

main().catch((e) => {
  console.error(`download-core: ${e.message}`)
  process.exit(1)
})
