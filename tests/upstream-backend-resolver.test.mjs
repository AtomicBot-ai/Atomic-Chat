import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  assetNameFor,
  compareVersions,
  manifestForTag,
  pickRelease,
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
  assert.equal(
    assetNameFor('b11344', 'linux-cpu-arm64'),
    'llama-b11344-bin-ubuntu-arm64.tar.gz'
  )
  assert.equal(
    assetNameFor('b11344', 'linux-vulkan-arm64'),
    'llama-b11344-bin-ubuntu-vulkan-arm64.tar.gz'
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

test('an arm64 CUDA family resolves only against arm64 assets', () => {
  const assets = [
    'llama-b11344-bin-win-cuda-13.5-x64.zip',
    'llama-b11344-bin-win-cuda-13.4-arm64.zip',
    'llama-b11344-bin-win-cpu-arm64.zip',
  ]
  assert.equal(
    resolveCudaFamily('win-cuda-13-arm64', 'b11344', assets),
    'win-cuda-13.4-arm64'
  )
  assert.equal(resolveCudaFamily('win-cuda-12-arm64', 'b11344', assets), null)
  assert.equal(
    assetNameFor('b11344', 'win-cpu-arm64'),
    'llama-b11344-bin-win-cpu-arm64.zip'
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

// The release list as atomic-chat-conf publishes it (backends/llamacpp-upstream-releases.json).
const archive = (tag, suffix, validation = 'approved') => ({
  name: `llama-${tag}-bin-${suffix}`,
  sha256: HASH,
  size: 10,
  validation,
})
const LIST = {
  schema_version: 1,
  download_base: MIRROR,
  releases: [
    // Needs a core with the fix it depends on.
    { tag: 'b11600', min_core_version: '0.16.0', assets: [archive('b11600', 'macos-arm64.tar.gz')] },
    {
      tag: 'b11550',
      min_core_version: '0.0.0',
      withdrawn: { reason: 'crashes on load' },
      assets: [archive('b11550', 'macos-arm64.tar.gz')],
    },
    {
      tag: 'b11500',
      min_core_version: '0.15.0',
      assets: [
        archive('b11500', 'macos-arm64.tar.gz'),
        archive('b11500', 'win-cuda-13.3-x64.zip'),
        archive('b11500', 'win-cuda-13.4-x64.zip', 'candidate'),
        archive('b11500', 'ubuntu-x64.tar.gz', 'candidate'),
      ],
    },
    {
      tag: 'b11463',
      min_core_version: '0.0.0',
      assets: [archive('b11463', 'ubuntu-x64.tar.gz'), archive('b11463', 'macos-arm64.tar.gz')],
    },
  ],
}

test('the bundled build is the one the pinned core would take', () => {
  const pick = (coreVersion, backend) => pickRelease(LIST, { coreVersion, backend })
  // Newest release this core meets, skipping one withdrawn and one for a newer core.
  assert.deepEqual(pick('0.15.0', 'macos-arm64'), { tag: 'b11500', backend: 'macos-arm64' })
  assert.deepEqual(pick('0.16.2', 'macos-arm64'), { tag: 'b11600', backend: 'macos-arm64' })
  assert.deepEqual(pick('0.14.0', 'macos-arm64'), { tag: 'b11463', backend: 'macos-arm64' })
  // A candidate archive is never bundled: Linux stays on the older approved build.
  assert.deepEqual(pick('0.15.0', 'linux-cpu-x64'), { tag: 'b11463', backend: 'linux-cpu-x64' })
  // A CUDA family resolves against approved archives only.
  assert.deepEqual(pick('0.15.0', 'win-cuda-13-x64'), { tag: 'b11500', backend: 'win-cuda-13.3-x64' })
  assert.equal(pick('0.15.0', 'win-vulkan-x64'), null)
  assert.equal(pickRelease(null, { coreVersion: '0.15.0', backend: 'macos-arm64' }), null)
})

test('any listed tag downloads from the mirror against its hash', () => {
  const manifest = manifestForTag(LIST, 'b11500')
  const asset = 'llama-b11500-bin-win-cuda-13.4-x64.zip'
  assert.deepEqual(pickSource(manifest, 'b11500', asset), {
    url: `${MIRROR}/b11500/${asset}`,
    sha256: HASH,
    size: 10,
  })
  assert.equal(manifestForTag(LIST, 'b10344'), null)
  assert.equal(manifestForTag(null, 'b11500'), null)
})

test('core versions compare numerically, as the core compares them', () => {
  assert.equal(compareVersions('0.15.0', '0.9.9'), 1)
  assert.equal(compareVersions('0.15.0', '0.15.0'), 0)
  assert.equal(compareVersions('0.15', '0.15.1'), -1)
})

