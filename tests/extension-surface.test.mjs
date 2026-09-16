/**
 * Every method the app calls on the llama.cpp extension exists on it.
 *
 * The provider interface in `@janhq/core` is only part of what the app uses: the backend-updater
 * screen, the model list and the import flow all reach for methods that are not on it, declared
 * instead as optional members of a local interface next to the call site. TypeScript is happy with
 * `extension.checkBackendForUpdates?.()` whether or not the method exists — the `?.` makes a
 * missing one a silent no-op, and the button does nothing.
 *
 * That is fine while one class implements everything. It stops being fine during the core
 * migration, where the same names have to keep working while what is behind them moves to another
 * process: a method routed to the core but dropped from the class, or renamed on the way, fails
 * exactly this way. So the call sites are read from the app and checked against the class.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXTENSION = join(REPO_ROOT, 'extensions', 'llamacpp-upstream-extension', 'src')

/**
 * Methods the app calls that are not on the provider interface.
 *
 * Read from the interface the backend updater declares, which is where the app writes down what it
 * expects of the extension. Keeping the list in one place there, rather than duplicated here, is
 * what makes this test track reality instead of a snapshot of it.
 */
function declaredOffContractMethods() {
  const source = readFileSync(
    join(REPO_ROOT, 'web-app', 'src', 'hooks', 'useBackendUpdater.ts'),
    'utf8'
  )
  const block = source.slice(
    source.indexOf('interface LlamacppExtension {'),
    source.indexOf('export interface BackendDownloadState')
  )
  return [...block.matchAll(/^\s{2}(\w+)\??\(/gm)].map((match) => match[1])
}

function extensionSource() {
  const files = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) files.push(path)
    }
  }
  walk(EXTENSION)
  return files.map((path) => readFileSync(path, 'utf8')).join('\n')
}

function declaresMethod(source, name) {
  return new RegExp(`(?:override\\s+)?(?:async\\s+)?${name}\\s*\\(`).test(source)
}

test('the extension implements every method the backend updater calls', () => {
  // A missing one is invisible at the call site: `extension.method?.()` on an absent method is a
  // no-op that resolves to undefined, so the button simply does nothing.
  const expected = declaredOffContractMethods()
  assert.ok(expected.length >= 8, `expected a real list of methods, got ${expected.length}`)

  const source = extensionSource()
  const missing = expected.filter((name) => !declaresMethod(source, name))

  assert.deepEqual(missing, [], `the app calls these, the extension does not define them: ${missing}`)
})

test('the core adapter exists and never opens an HTTP connection of its own', () => {
  // The control token lives in Rust. A URL here would mean the webview held a credential that can
  // load models and start processes.
  const adapter = join(EXTENSION, 'adapter', 'coreRuntime.ts')
  assert.ok(existsSync(adapter), 'the adapter is what the migrated methods route through')

  const source = readFileSync(adapter, 'utf8')
  assert.ok(
    !/fetch\s*\(|http:\/\/|https:\/\//.test(source.replace(/^\s*\*.*$/gm, '')),
    'the adapter must go through the atomic_core_call command, not over HTTP'
  )
})

test('every core call the adapter makes goes through the one Rust command', () => {
  const source = readFileSync(join(EXTENSION, 'adapter', 'coreRuntime.ts'), 'utf8')
  const invoked = [...source.matchAll(/invoke<[^>]*>\(\s*'([^']+)'/g)].map((m) => m[1])

  const allowed = new Set(['atomic_core_call', 'atomic_core_status', 'get_atomic_core_flags'])
  const unexpected = invoked.filter((name) => !allowed.has(name))

  assert.deepEqual(unexpected, [], `unexpected commands: ${unexpected.join(', ')}`)
})

test('the migrated methods ask who owns the runtime before choosing a path', () => {
  // Each of these has two implementations now. Reading the flag is what picks one, and forgetting
  // to read it is how a method silently keeps talking to the plugin after the handover.
  const source = readFileSync(join(EXTENSION, 'index.ts'), 'utf8')
  const migrated = [
    'override async load(',
    'override async unload(',
    'override async getLoadedModels(',
    'async validateGgufFile(',
    'async checkMmprojExists(',
    'async getDevices(',
    'async listInstalledBackends(',
    'async deleteBackend(',
  ]

  const withoutCheck = migrated.filter((signature) => {
    const start = source.indexOf(signature)
    if (start === -1) return true
    // The check is near the top of the method; a generous window keeps this from depending on
    // exactly how the body is laid out.
    return !source.slice(start, start + 2000).includes('coreOwnsRuntime()')
  })

  assert.deepEqual(
    withoutCheck,
    [],
    `these methods do not consult the ownership flag: ${withoutCheck.join(', ')}`
  )
})
