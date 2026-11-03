import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

// The desktop app runs `atomic-chat-app-core`, and Foundry Local's host mode of that binary loads
// Microsoft's dylibs (Team ID UBF8T346G9). Under the Hardened Runtime that notarization requires,
// library validation refuses a dylib signed by another team ("mapping process and mapped file
// (non-platform) have different Team IDs"), so the binary must carry
// `com.apple.security.cs.disable-library-validation` (openspec change add-foundry-local, task 8.5;
// core rulings S3). Bun's JIT entitlements are needed by every core binary
// (ADR 2026-09-15-sign-the-core-with-jit-entitlements).

const ROOT = new URL('..', import.meta.url).pathname
const read = (path) => readFileSync(join(ROOT, path), 'utf8')

const entitlementKeys = (plist) =>
  [...plist.matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)].map((match) => match[1])

test('the sidecar entitlements allow Bun’s JIT and libraries signed by another team', () => {
  const keys = entitlementKeys(read('src-tauri/Entitlements.sidecar.plist'))
  for (const key of [
    'com.apple.security.cs.allow-jit',
    'com.apple.security.cs.allow-unsigned-executable-memory',
    'com.apple.security.cs.disable-library-validation',
  ]) {
    assert.ok(keys.includes(key), `Entitlements.sidecar.plist lacks ${key}`)
  }
})

/** The macOS branch of `build-cli-core`, up to its `endif`. */
function buildCliCore() {
  const makefile = read('Makefile')
  const target = makefile.slice(makefile.indexOf('build-cli-core:'))
  return target.slice(0, target.indexOf('\nendif'))
}

/** The sidecar-entitlement case and the resources/bin loop of the pre-bundle signing pass. */
function preBundleSigning() {
  const script = read('src-tauri/scripts/sign-macos-resource-binaries.sh')
  const sidecars = script.match(/^\s*([\w| -]+)\)\s*entitlements="\$SIDE_ENT"/m)
  assert.ok(sidecars, 'no case gives the sidecar entitlements')
  const signed = script.match(/for name in ([^;]+); do\s*\n\s*sign_if_macho "\$BIN\/\$name"/)
  assert.ok(signed, 'no loop over resources/bin')
  return {
    sidecars: sidecars[1].split('|').map((name) => name.trim()),
    signed: signed[1].split(/\s+/),
  }
}

test('make build-cli signs atomic-chat-app-core with the sidecar entitlements', () => {
  const body = buildCliCore()
  assert.match(body, /for binary in [^;]*\batomic-chat-app-core\b/)
  assert.match(body, /--entitlements src-tauri\/Entitlements\.sidecar\.plist/)
})

test('the pre-bundle signing pass signs atomic-chat-app-core with the sidecar entitlements', () => {
  const { sidecars, signed } = preBundleSigning()
  assert.ok(sidecars.includes('atomic-chat-app-core'))
  assert.ok(signed.includes('atomic-chat-app-core'))
})

// The installer ships only upstream llama.cpp and the core pair (ADR 2026-10-27): no `jan-cli` copy
// of the core and no `mlx-server`, so nothing copies or signs them before bundling.
test('the signing passes leave out the binaries the installer no longer ships', () => {
  const body = buildCliCore()
  assert.doesNotMatch(body, /jan-cli/)
  const { sidecars, signed } = preBundleSigning()
  for (const name of ['jan-cli', 'mlx-server']) {
    assert.ok(!sidecars.includes(name), `${name} still gets the sidecar entitlements`)
    assert.ok(!signed.includes(name), `${name} is still signed before bundling`)
  }
})
