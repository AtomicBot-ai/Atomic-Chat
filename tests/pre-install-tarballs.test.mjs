/**
 * The bundled extension tarballs keep their legacy `@janhq/*` names.
 *
 * The installer resolves extensions by package name, and the names are written into user data the
 * first time an app runs — `extensions.json` in the data folder records which package provides
 * which engine. Renaming a package therefore does not rename it for anyone who already installed
 * it: their extension simply disappears and their local models stop having a provider.
 *
 * That is why the core migration deliberately does not rename these (PLAN.md §4, stage 3d: "the adapter
 * is **not** a separate tarball"). The adapter ships *inside* the existing package rather than beside it:
 * two packages claiming one provider would race in `EngineManager`, and whichever registered last
 * would win, unpredictably.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PRE_INSTALL = join(REPO_ROOT, 'src-tauri', 'resources', 'pre-install')
const EXTENSIONS = join(REPO_ROOT, 'extensions')

/** `@janhq/llamacpp-upstream-extension` → `janhq-llamacpp-upstream-extension`. */
function tarballPrefix(packageName) {
  return packageName.replace(/^@/, '').replace('/', '-')
}

function extensionPackages() {
  return readdirSync(EXTENSIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(EXTENSIONS, entry.name, 'package.json'))
    .filter(existsSync)
    .map((path) => JSON.parse(readFileSync(path, 'utf8')))
}

test('every bundled extension still publishes under its legacy @janhq name', () => {
  const wrong = extensionPackages()
    .map((pkg) => pkg.name)
    .filter((name) => !name.startsWith('@janhq/'))

  assert.deepEqual(
    wrong,
    [],
    'renaming a package orphans it for everyone who already installed it: the installer resolves ' +
      'extensions by name, and the name is recorded in the user data folder on first run'
  );
})

test('each extension has a pre-install tarball under the name the installer looks for', () => {
  const tarballs = readdirSync(PRE_INSTALL).filter((name) => name.endsWith('.tgz'))

  const missing = extensionPackages()
    .map((pkg) => tarballPrefix(pkg.name))
    .filter((prefix) => !tarballs.some((file) => file.startsWith(`${prefix}-`)))

  assert.deepEqual(missing, [], `no bundled tarball for: ${missing.join(', ')}`)
})

test('no two bundled extensions claim the same provider id', () => {
  // `engine` is a family label — both llama.cpp extensions legitimately carry `llama.cpp`. What
  // must be unique is the provider id the class registers, because two packages registering the
  // same one race in `EngineManager` and whichever registers last wins, by directory order. The
  // core adapter therefore ships inside the existing package rather than as a second one.
  const byProvider = new Map()
  for (const entry of readdirSync(EXTENSIONS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const source = join(EXTENSIONS, entry.name, 'src', 'index.ts')
    if (!existsSync(source)) continue
    const declared = readFileSync(source, 'utf8').match(
      /readonly\s+providerId\s*:\s*string\s*=\s*'([^']+)'/
    )
    if (!declared) continue
    const seen = byProvider.get(declared[1]) ?? []
    seen.push(entry.name)
    byProvider.set(declared[1], seen)
  }

  assert.ok(byProvider.size > 0, 'the scan found no provider ids at all, so it proves nothing')

  const duplicated = [...byProvider.entries()]
    .filter(([, dirs]) => dirs.length > 1)
    .map(([provider, dirs]) => `${provider}: ${dirs.join(', ')}`)

  assert.deepEqual(duplicated, [], 'one provider, one package')
})

test('the llama.cpp upstream extension is bundled, since local inference depends on it', () => {
  const tarballs = readdirSync(PRE_INSTALL)

  assert.ok(
    tarballs.some((name) => name.startsWith('janhq-llamacpp-upstream-extension-')),
    'the provider that owns local models must ship with the app'
  )
})
