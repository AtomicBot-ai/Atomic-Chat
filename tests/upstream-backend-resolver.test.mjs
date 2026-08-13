import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  assetNameFor,
  pickSource,
  resolveCudaFamily,
} from '../scripts/resolve-upstream-backend.mjs'

const GGML_ORG = 'https://github.com/ggml-org/llama.cpp/releases/download'
const MIRROR = 'https://github.com/AtomicBot-ai/atomic-chat-conf/releases/download'
const HASH = 'a'.repeat(64)

test('asset names follow the per-platform upstream naming', () => {
  assert.equal(
    assetNameFor('b10405', 'macos-arm64'),
    'llama-b10405-bin-macos-arm64.tar.gz'
  )
  assert.equal(
    assetNameFor('b10405', 'win-cuda-13.3-x64'),
    'llama-b10405-bin-win-cuda-13.3-x64.zip'
  )
  // Upstream calls its Linux builds ubuntu-*, the app's ids say linux-*.
  assert.equal(
    assetNameFor('b10405', 'linux-cpu-x64'),
    'llama-b10405-bin-ubuntu-x64.tar.gz'
  )
  assert.equal(
    assetNameFor('b10405', 'linux-vulkan-x64'),
    'llama-b10405-bin-ubuntu-vulkan-x64.tar.gz'
  )
})

test('a CUDA family id resolves to the highest minor the tag ships', () => {
  const assets = [
    'llama-b10405-bin-win-cuda-12.4-x64.zip',
    'llama-b10405-bin-win-cuda-13.3-x64.zip',
    'llama-b10405-bin-win-cuda-13.7-x64.zip',
    'llama-b10405-bin-win-cpu-x64.zip',
  ]
  assert.equal(
    resolveCudaFamily('win-cuda-13-x64', 'b10405', assets),
    'win-cuda-13.7-x64'
  )
  assert.equal(
    resolveCudaFamily('win-cuda-12-x64', 'b10405', assets),
    'win-cuda-12.4-x64'
  )
  // A major the tag does not ship must fail loudly, not silently downgrade.
  assert.equal(resolveCudaFamily('win-cuda-11-x64', 'b10405', assets), null)
  // A concrete id is already resolved and passes through untouched.
  assert.equal(
    resolveCudaFamily('win-cuda-13.3-x64', 'b10405', assets),
    'win-cuda-13.3-x64'
  )
})

test('a mirrored asset resolves to our release stream with its hash', () => {
  const manifest = {
    tag_name: 'b10405',
    download_base: MIRROR,
    assets: [
      {
        name: 'llama-b10405-bin-macos-arm64.tar.gz',
        sha256: HASH,
        size: 11083379,
      },
    ],
  }
  const source = pickSource(
    manifest,
    'b10405',
    'llama-b10405-bin-macos-arm64.tar.gz'
  )
  assert.equal(
    source.url,
    `${MIRROR}/b10405/llama-b10405-bin-macos-arm64.tar.gz`
  )
  assert.equal(source.sha256, HASH)
  assert.equal(source.size, 11083379)
})

test('anything not mirrored falls back to the upstream CDN without a hash', () => {
  const mirrored = {
    tag_name: 'b10405',
    download_base: MIRROR,
    assets: [
      { name: 'llama-b10405-bin-macos-arm64.tar.gz', sha256: HASH, size: 1 },
    ],
  }
  const asset = 'llama-b10405-bin-macos-arm64.tar.gz'

  // A manifest that predates the mirror carries no download_base.
  const unmirrored = { tag_name: 'b10405', assets: [{ name: asset }] }
  assert.deepEqual(pickSource(unmirrored, 'b10405', asset), {
    url: `${GGML_ORG}/b10405/${asset}`,
  })

  // Reinstalling an older tag than the one the manifest describes.
  const older = 'llama-b10344-bin-macos-arm64.tar.gz'
  assert.deepEqual(pickSource(mirrored, 'b10344', older), {
    url: `${GGML_ORG}/b10344/${older}`,
  })

  // The cudart companions stay upstream: listed, but with no hash.
  const cudart = {
    tag_name: 'b10405',
    download_base: MIRROR,
    assets: [{ name: 'cudart-llama-bin-win-cuda-13.3-x64.zip' }],
  }
  assert.deepEqual(
    pickSource(cudart, 'b10405', 'cudart-llama-bin-win-cuda-13.3-x64.zip'),
    { url: `${GGML_ORG}/b10405/cudart-llama-bin-win-cuda-13.3-x64.zip` }
  )

  // No manifest at all (offline pinned build).
  assert.deepEqual(pickSource(null, 'b10405', asset), {
    url: `${GGML_ORG}/b10405/${asset}`,
  })
})

test('no build path hardcodes the upstream download base again', () => {
  // This resolution used to be copy-pasted into three Makefile branches, a
  // PowerShell branch and the Windows release job, every one of them pinned to
  // the ggml-org CDN. The mirror only helps if those paths keep asking the
  // resolver, so a sixth copy has to fail here rather than in review.
  const expected = {
    'Makefile': 0,
    '.github/workflows/release.yml': 0,
    'scripts/build-windows-release.ps1': 0,
    // One legitimate fallback: New-BackendSource must keep working when the
    // manifest names no mirror, and it cannot call the resolver (see the
    // comment there on why it returns null instead of exiting).
    'scripts/dev-windows.ps1': 1,
  }
  for (const [path, limit] of Object.entries(expected)) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
    const hits = source.match(
      /ggml-org\/llama\.cpp\/releases\/download/g
    )
    assert.equal(
      hits?.length ?? 0,
      limit,
      `${path} must reference the ggml-org download base exactly ${limit} time(s); use scripts/resolve-upstream-backend.mjs instead`
    )
  }
})

test('a hash without a size is not trusted', () => {
  // The Rust downloader checks size first and hash second; a hash on its own
  // would skip the cheap guard, so the pair is required.
  const manifest = {
    tag_name: 'b10405',
    download_base: MIRROR,
    assets: [{ name: 'llama-b10405-bin-macos-arm64.tar.gz', sha256: HASH }],
  }
  const source = pickSource(
    manifest,
    'b10405',
    'llama-b10405-bin-macos-arm64.tar.gz'
  )
  assert.equal(source.sha256, undefined)
  assert.match(source.url, /ggml-org/)
})
