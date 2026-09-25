/**
 * Every method the app calls on the llama.cpp extension exists on it.
 *
 * The provider interface in `@janhq/core` is only part of what the app uses: the backend-updater
 * screen, the model list and the import flow all reach for methods that are not on it, declared
 * instead as optional members of a local interface next to the call site. TypeScript is happy with
 * `extension.checkBackendForUpdates?.()` whether or not the method exists — the `?.` makes a
 * missing one a silent no-op, and the button does nothing.
 *
 * The migration to `atomic-chat-core` moved what is behind these names to another process: a method
 * dropped from the class, or renamed on the way, fails exactly this way. So the call sites are read
 * from the app and checked against the class — and no extension may reach back for the plugin
 * commands that used to own model processes.
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

const SHARED_ADAPTER = join(REPO_ROOT, 'extensions', 'shared')

test('the core adapter exists and never opens an HTTP connection of its own', () => {
  // The control token lives in Rust. A URL here would mean the webview held a credential that can
  // load models and start processes.
  const adapter = join(EXTENSION, 'adapter', 'coreRuntime.ts')
  assert.ok(existsSync(adapter), 'the adapter is what the migrated methods route through')

  for (const path of [
    adapter,
    join(SHARED_ADAPTER, 'atomicCoreRuntime.ts'),
    join(SHARED_ADAPTER, 'atomicCoreSettingsSync.ts'),
  ]) {
    const source = readFileSync(path, 'utf8')
    assert.ok(
      !/fetch\s*\(|http:\/\/|https:\/\//.test(source.replace(/^\s*\*.*$/gm, '')),
      `${path} must go through the atomic_core_call command, not over HTTP`
    )
  }
})

test('every core call the adapter makes goes through the Rust core commands', () => {
  const source = readFileSync(join(SHARED_ADAPTER, 'atomicCoreRuntime.ts'), 'utf8')
  const invoked = [...source.matchAll(/invoke<[^>]*>\(\s*'([^']+)'/g)].map((m) => m[1])
  assert.ok(invoked.includes('atomic_core_call'), 'the shared adapter is the one that invokes')

  const allowed = new Set(['atomic_core_call', 'atomic_core_status', 'atomic_core_snapshot'])
  const unexpected = invoked.filter((name) => !allowed.has(name))

  assert.deepEqual(unexpected, [], `unexpected commands: ${unexpected.join(', ')}`)
})

// Stage 6: the core owns every local model process on desktop, and the plugins no longer register
// the commands that started, found or stopped one. A call left behind fails only at run time, as an
// unknown command, so it is caught here instead.
const REMOVED_PLUGIN_COMMANDS = [
  'load_llama_model', 'unload_llama_model', 'get_devices', 'get_runtime_device', 'generate_api_key',
  'is_process_running', 'get_random_port', 'find_session_by_model', 'get_loaded_models',
  'get_all_sessions', 'get_session_by_model', 'estimate_kv_cache_size', 'get_model_size',
  'cleanup_llama_processes', 'load_mlx_model', 'unload_mlx_model', 'is_mlx_process_running',
  'get_mlx_random_port', 'find_mlx_session_by_model', 'get_mlx_loaded_models', 'get_mlx_all_sessions',
  'cleanup_mlx_processes',
]
const REMOVED_GUEST_FUNCTIONS = [
  'loadLlamaModel', 'unloadLlamaModel', 'getDevices', 'getRuntimeDevice', 'generateApiKey',
  'isProcessRunning', 'getRandomPort', 'findSessionByModel', 'getLoadedModels', 'getAllSessions',
  'getSessionByModel', 'estimateKVCacheSize', 'getModelSize', 'cleanupLlamaProcesses', 'loadMlxModel',
  'unloadMlxModel', 'isMlxProcessRunning', 'getMlxRandomPort', 'findMlxSessionByModel',
  'getMlxLoadedModels', 'getMlxAllSessions', 'cleanupMlxProcesses',
]

function sourcesUnder(dir) {
  const files = []
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name)
      if (name === 'node_modules' || name === 'dist') continue
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(path)
    }
  }
  walk(dir)
  return files
}

test('no extension calls a plugin command that used to own a model process', () => {
  const offenders = []
  for (const extension of [
    'llamacpp-extension',
    'llamacpp-upstream-extension',
    'mlx-extension',
    'foundation-models-extension',
    'download-extension',
  ]) {
    for (const path of sourcesUnder(join(REPO_ROOT, 'extensions', extension, 'src'))) {
      const source = readFileSync(path, 'utf8')
      for (const [, command] of source.matchAll(/'plugin:[\w-]+\|(\w+)'/g))
        if (REMOVED_PLUGIN_COMMANDS.includes(command)) offenders.push(`${path}: ${command}`)
      for (const [, names] of source.matchAll(
        /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'@janhq\/tauri-plugin-[\w-]+-api'/g
      ))
        for (const name of names.split(',').map((n) => n.trim().split(/\s+as\s+/)[0]))
          if (REMOVED_GUEST_FUNCTIONS.includes(name)) offenders.push(`${path}: ${name}`)
    }
  }
  assert.deepEqual(offenders, [], `removed plugin commands are still called:\n${offenders.join('\n')}`)
})

test('no extension asks who owns the runtime any more', () => {
  const offenders = []
  for (const extension of ['llamacpp-extension', 'llamacpp-upstream-extension', 'mlx-extension', 'foundation-models-extension', 'download-extension']) {
    for (const path of sourcesUnder(join(REPO_ROOT, 'extensions', extension, 'src'))) {
      const source = readFileSync(path, 'utf8')
      for (const needle of ['coreOwnsRuntime', 'withRuntimeLoad', 'active_runtime', 'atomic_core_begin_runtime_load', 'get_atomic_core_flags'])
        if (source.includes(needle)) offenders.push(`${path}: ${needle}`)
    }
  }
  assert.deepEqual(offenders, [], `ownership checks left behind:\n${offenders.join('\n')}`)
})
