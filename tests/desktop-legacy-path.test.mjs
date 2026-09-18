/**
 * The desktop inference path has no legacy half left (PLAN.md stage 6).
 *
 * `atomic-chat-core` owns every local model process and the public API on desktop. The app used to
 * do both itself — plugin session maps, the in-app proxy, ownership flags and a handover between the
 * two — and every one of those removed pieces fails only at run time if something reaches for it
 * again: an unknown Tauri command, an event nobody emits, a proxy that never starts. This reads the
 * sources the desktop app is built from and fails on the way back in.
 *
 * Mobile is the exception on purpose: it has no core and keeps the app's proxy for cloud chat, so
 * that proxy stays compiled, behind `#[cfg(mobile)]`.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function sources(dir, extensions) {
  const files = []
  const walk = (current) => {
    for (const name of readdirSync(current)) {
      if (name === 'node_modules' || name === 'dist' || name === 'target') continue
      const path = join(current, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (extensions.some((ext) => name.endsWith(ext)) && !/\.test\.tsx?$/.test(name))
        files.push(path)
    }
  }
  walk(dir)
  return files
}

const webviewSources = () => [
  ...sources(join(ROOT, 'web-app', 'src'), ['.ts', '.tsx']),
  ...readdirSync(join(ROOT, 'extensions'))
    .map((name) => join(ROOT, 'extensions', name, 'src'))
    .filter((dir) => {
      try {
        return statSync(dir).isDirectory()
      } catch {
        return false
      }
    })
    .flatMap((dir) => sources(dir, ['.ts', '.tsx'])),
]

const where = (path) => relative(ROOT, path)

// What the runtime plugins may still be asked from the webview: GGUF reading, backend selection and
// catalogue bookkeeping, the MLX server version. Nothing here starts, finds or stops a process.
const PLUGIN_UTILITY_COMMANDS = {
  llamacpp: [
    'read_gguf_metadata',
    'is_model_supported',
    'map_old_backend_to_new',
    'get_local_installed_backends',
    'list_supported_backends',
    'determine_supported_backends',
    'get_supported_features',
    'find_latest_version_for_backend',
    'prioritize_backends',
    'check_backend_for_updates',
    'remove_old_backend_versions',
    'should_migrate_backend',
    'handle_setting_update',
    'install_bundled_backend',
  ],
  'llamacpp-upstream': [
    'check_spec_type_support',
    'read_gguf_metadata',
    'is_model_supported',
    'map_old_backend_to_new',
    'get_local_installed_backends',
    'list_supported_backends',
    'determine_supported_backends',
    'get_supported_features',
    'find_latest_version_for_backend',
    'prioritize_backends',
    'check_backend_for_updates',
    'remove_old_backend_versions',
    'should_migrate_backend',
    'handle_setting_update',
    'install_bundled_backend',
    'fetch_manifest_http1',
  ],
  mlx: ['get_mlx_server_version'],
}

test('the runtime plugins register only utility commands', () => {
  for (const [plugin, allowed] of Object.entries(PLUGIN_UTILITY_COMMANDS)) {
    const lib = readFileSync(
      join(ROOT, 'src-tauri', 'plugins', `tauri-plugin-${plugin}`, 'src', 'lib.rs'),
      'utf8'
    )
    const handler = lib.slice(lib.indexOf('generate_handler!['), lib.indexOf(']', lib.indexOf('generate_handler![')))
    const registered = [...handler.matchAll(/(\w+)\s*(?:,|$)/g)].map((m) => m[1]).filter((n) => n !== 'generate_handler')
    const unexpected = registered.filter((name) => !allowed.includes(name))
    assert.ok(registered.length > 0, `${plugin}: no commands found in lib.rs`)
    assert.deepEqual(unexpected, [], `${plugin} registers commands beyond its utilities: ${unexpected}`)
  }
})

test('the Foundation Models plugin is gone', () => {
  assert.throws(() =>
    statSync(join(ROOT, 'src-tauri', 'plugins', 'tauri-plugin-foundation-models', 'src'))
  )
  const cargo = readFileSync(join(ROOT, 'src-tauri', 'Cargo.toml'), 'utf8')
  assert.ok(!cargo.includes('tauri-plugin-foundation-models'), 'Cargo.toml still depends on it')
})

test('the webview calls no plugin command outside the utilities', () => {
  const offenders = []
  for (const path of webviewSources()) {
    const source = readFileSync(path, 'utf8')
    for (const [, plugin, command] of source.matchAll(
      /['"`]plugin:(llamacpp-upstream|llamacpp|mlx|foundation-models)\|(\w+)['"`]/g
    )) {
      if (!(PLUGIN_UTILITY_COMMANDS[plugin] ?? []).includes(command))
        offenders.push(`${where(path)}: plugin:${plugin}|${command}`)
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'))
})

test('the webview no longer reaches for ownership flags, leases or the legacy crash event', () => {
  const removed = [
    'get_atomic_core_flags',
    'set_atomic_core_flags',
    'atomic_core_begin_runtime_load',
    'atomic_core_end_runtime_load',
    'get_provider_config',
    'list_provider_configs',
    'llamacpp_upstream_session_died',
    '@janhq/tauri-plugin-foundation-models-api',
    // Moved into the core with image generation: the tunnel and LAN listing are
    // `/atomic/v1/remote-access` and `/lan-addresses`, free disk space is `POST /disk/available`,
    // and a load is cancelled with `POST /models/:provider/:id/load/cancel`.
    'get_remote_access_status',
    'start_remote_access',
    'stop_remote_access',
    'get_lan_addresses',
    'available_disk_space',
    // The image-generation plugin of v2.0.38-2.0.40, now `/atomic/v1/diffusion/*` in the core. Its
    // seam built command names from a prefix (`${PLUGIN}|configure`) and listened on
    // `atomic-diffusion://state`, so the prefixes themselves are what must not come back.
    'plugin:atomic-diffusion',
    'atomic-diffusion://',
    // The runtime plugins' own load-cancel commands, now the core's `load/cancel` route.
    'cancel_llama_model_load',
    'cancel_mlx_model_load',
  ]
  const offenders = []
  for (const path of webviewSources()) {
    const source = readFileSync(path, 'utf8')
    for (const needle of removed) if (source.includes(needle)) offenders.push(`${where(path)}: ${needle}`)
  }
  assert.deepEqual(offenders, [], offenders.join('\n'))
})

test('the app Rust has no ownership flags, handover or plugin session maps', () => {
  const removed = [
    'AtomicCoreFlags',
    'CoreRuntimeOwner',
    'CoreServerOwner',
    'hand_over',
    'begin_runtime_load',
    'set_core_dir',
    'llama_server_process',
    'cleanup_llama_processes',
    'cleanup_mlx_processes',
    'tauri_plugin_foundation_models',
    'core::cli::',
    // Image generation, the public image route, the Remote Access tunnel, per-request trusted
    // hosts and load cancellation all moved into the core (its `src/diffusion/`,
    // `src/server/public/{images,dynamic-hosts}.ts`, `src/remote-access/`, `load-cancel.ts`).
    'tauri_plugin_atomic_diffusion',
    'mod remote_access',
    'mod images_route',
    'mod dynamic_hosts',
  ]
  const offenders = []
  for (const path of sources(join(ROOT, 'src-tauri', 'src'), ['.rs'])) {
    const source = readFileSync(path, 'utf8')
    for (const needle of removed) if (source.includes(needle)) offenders.push(`${where(path)}: ${needle}`)
    for (const [use] of source.matchAll(/tauri_plugin_(?:llamacpp_upstream|llamacpp|mlx)::\w+/g))
      if (!use.endsWith('::init')) offenders.push(`${where(path)}: ${use}`)
  }
  assert.deepEqual(offenders, [], offenders.join('\n'))
})

test('the utils crate and the runtime plugins carry no load-cancel machinery', () => {
  // v2.0.40 kept it in `src-tauri/utils/src/load_cancel.rs` (`jan_utils::load_cancel`) and in each
  // runtime plugin's state and commands; the core's `load/cancel` route replaced all of it.
  const roots = [
    join(ROOT, 'src-tauri', 'utils', 'src'),
    ...readdirSync(join(ROOT, 'src-tauri', 'plugins'))
      .map((name) => join(ROOT, 'src-tauri', 'plugins', name, 'src'))
      .filter((dir) => {
        try {
          return statSync(dir).isDirectory()
        } catch {
          return false
        }
      }),
  ]
  const offenders = []
  for (const path of roots.flatMap((dir) => sources(dir, ['.rs']))) {
    const source = readFileSync(path, 'utf8')
    for (const needle of ['load_cancel', 'LoadCancelRegistry', 'cancel_llama_model_load', 'cancel_mlx_model_load'])
      if (source.includes(needle)) offenders.push(`${where(path)}: ${needle}`)
  }
  assert.deepEqual(offenders, [], offenders.join('\n'))
})

test("the app's own proxy is only reachable on mobile", () => {
  const commands = readFileSync(join(ROOT, 'src-tauri', 'src', 'core', 'server', 'commands.rs'), 'utf8')
  assert.match(commands, /#\[cfg\(mobile\)\]\s*pub struct LegacyOwner/, 'LegacyOwner must stay mobile-only')
  const outsideTests = sources(join(ROOT, 'src-tauri', 'src'), ['.rs']).filter(
    (path) => !/(integration_tests|fixture_dump|tests)\.rs$/.test(path)
  )
  const starters = outsideTests.filter((path) =>
    readFileSync(path, 'utf8').includes('proxy::start_server(')
  )
  assert.deepEqual(starters.map(where), ['src-tauri/src/core/server/commands.rs'])
})
