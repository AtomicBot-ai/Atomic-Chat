// Fetch the compiled `atomic-chat-core` binary this app version is pinned to.
//
// The core is built and released from its own repository (`atomic-chat-core`), which publishes one
// CLI and app binaries per target plus a `SHA256SUMS` file. This script downloads what the current platform
// needs, verifies it against that file, and leaves it at
// `src-tauri/resources/bin/atomic-chat-core[.exe]`, where `make build-cli` copies it to `jan-cli`
// and signs it. On macOS both architectures are fetched and `lipo`'d into one universal binary, so
// the same .app runs on Apple silicon and Intel.
//
//   node scripts/download-core.mjs                 # the version pinned in package.json
//   node scripts/download-core.mjs --version 0.2.0 # an explicit one
//   ATOMIC_CORE_LOCAL=/path/to/cli ATOMIC_APP_CORE_LOCAL=/path/to/app-core node scripts/download-core.mjs
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

const names = ['atomic-chat-core', 'atomic-chat-app-core']
const outputName = (name) => (process.platform === 'win32' ? `${name}.exe` : name)

function verifyBinaryVersion(binary) {
  if (!VERSION) throw new Error('No pinned core version in package.json')
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 15_000 })
  if (result.error || result.status !== 0 || result.stdout.trim() !== VERSION)
    throw new Error(`Bundled core version mismatch: expected ${VERSION}, got ${result.stdout?.trim() || result.error?.message || result.stderr?.trim() || 'no answer'}`)
}

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
  if (process.argv.includes('--verify-only')) {
    for (const name of names) verifyBinaryVersion(path.join(BIN_DIR, outputName(name)))
    return
  }
  if (process.env.SKIP_BINARIES) {
    console.log('Skipping atomic-chat-core download.')
    return
  }
  mkdirSync(BIN_DIR, { recursive: true })
  // Both binaries are one compatible pair: a local override must supply both.
  const locals = [process.env.ATOMIC_CORE_LOCAL, process.env.ATOMIC_APP_CORE_LOCAL]
  if (locals.some(Boolean)) {
    if (locals.some((path) => !path)) throw new Error('Set ATOMIC_CORE_LOCAL and ATOMIC_APP_CORE_LOCAL together')
    for (const [index, name] of names.entries()) {
      const local = locals[index]
      const output = path.join(BIN_DIR, outputName(name))
      if (!existsSync(local)) throw new Error(`Local core binary does not exist: ${local}`)
      copyFileSync(local, output)
      if (process.platform !== 'win32') chmodSync(output, 0o755)
      verifyBinaryVersion(output)
      console.log(`Using local core build: ${local} -> ${output}`)
    }
    return
  }

  if (!VERSION) {
    throw new Error('No core version: set `atomicCore.version` in package.json or pass --version')
  }
  mkdirSync(CACHE_DIR, { recursive: true })

  const sumsPath = path.join(CACHE_DIR, `SHA256SUMS-${VERSION}`)
  if (!existsSync(sumsPath)) await download(`${BASE}/SHA256SUMS`, sumsPath)
  const checksums = parseChecksums(readFileSync(sumsPath, 'utf8'))

  for (const name of names) {
    const output = path.join(BIN_DIR, outputName(name))
    const downloaded = []
    for (const triple of targetsFor(process.platform, os.arch())) {
      const asset = `${name}-${VERSION}-${triple}`
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
    verifyBinaryVersion(output)
  }

  // Record what is on disk so `make build-cli` and a developer can tell at a glance.
  writeFileSync(path.join(BIN_DIR, 'atomic-chat-core-version.txt'), `${VERSION}\n`)
  console.log(`atomic-chat-core ${VERSION} binary pair ready in ${BIN_DIR}`)
}

main().catch((e) => {
  console.error(`download-core: ${e.message}`)
  process.exit(1)
})
