import { readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { Routes, routeToCommand } from '@/lib/service'

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../..'
)
const TAURI_ROOT = join(REPO_ROOT, 'src-tauri')
const PLUGINS_ROOT = join(TAURI_ROOT, 'plugins')

const EXPECTED_DESKTOP_ONLY = new Set([
  'check_for_app_updates',
  'get_local_http',
  'is_update_available',
  'post_local_http',
  'set_telemetry_consent',
  'set_telemetry_context',
  'set_telemetry_user',
  'stream_local_http',
])
const EXPECTED_MOBILE_ONLY = new Set(['abort_remote_stream'])
const EXPECTED_PLUGIN_IDS = [
  'foundation-models',
  'hardware',
  'llamacpp',
  'llamacpp-upstream',
  'mlx',
  'rag',
  'vector-db',
]

// Core still exposes these legacy Jan routes to browser/default services. They
// are implemented with web APIs or service adapters rather than Rust commands.
const KNOWN_NON_TAURI_ROUTES = new Set([
  'ack_deep_link',
  'app_update_download',
  'append_file_sync',
  'base_extensions',
  'base_name',
  'copy_file',
  'dir_name',
  'get_gguf_files',
  'get_resource_path',
  'hide_main_window',
  'hide_quick_ask_window',
  'install_extension',
  'invoke_extension_func',
  'is_subdirectory',
  'log',
  'open_external_url',
  'quick_ask_size_updated',
  'select_directory',
  'select_files',
  'send_quick_ask_input',
  'set_close_app',
  'set_maximize_app',
  'set_minimize_app',
  'set_native_theme_dark',
  'set_native_theme_light',
  'show_main_window',
  'show_open_menu',
  'show_toast',
  'unlink_sync',
  'uninstall_extension',
  'update_extension',
  'write_blob',
  'write_env_file_to_config',
])

// These calls predate the current Rust surface. Keeping the exceptions tied to
// exact names ensures that any newly introduced missing command still fails.
const KNOWN_UNREGISTERED_APP_COMMANDS = new Set([
  'install_extension',
  'security_clear_logs',
  'security_generate_token',
  'security_get_devices',
  'security_get_logs',
  'security_get_status',
  'security_revoke_device',
  'security_set_auth_mode',
  'security_set_password',
  'security_set_require_pairing',
  'uninstall_extension',
])

function read(path: string): string {
  return readFileSync(path, 'utf8')
}

function setDifference(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  return new Set([...left].filter((value) => !right.has(value)))
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort()
}

function extractDelimited(
  source: string,
  marker: string,
  open = '[',
  close = ']'
): string {
  const markerIndex = source.indexOf(marker)
  if (markerIndex < 0) throw new Error(`Missing marker: ${marker}`)

  const start = source.indexOf(open, markerIndex + marker.length)
  if (start < 0) throw new Error(`Missing ${open} after marker: ${marker}`)

  let depth = 0
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === open) depth += 1
    if (source[index] === close) depth -= 1
    if (depth === 0) return source.slice(start + 1, index)
  }
  throw new Error(`Unclosed ${open} after marker: ${marker}`)
}

function commandNamesFromHandler(body: string): Set<string> {
  const withoutComments = body.replace(/\/\/.*$/gm, '')
  return new Set(
    withoutComments
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => entry.split('::').at(-1)!)
  )
}

function appHandlerSets(): {
  desktop: Set<string>
  mobile: Set<string>
} {
  const source = read(join(TAURI_ROOT, 'src/lib.rs'))
  const marker = '.invoke_handler(tauri::generate_handler!'
  const firstStart = source.indexOf(marker)
  const desktopBody = extractDelimited(source.slice(firstStart), marker)
  const secondStart = source.indexOf(marker, firstStart + marker.length)
  const mobileBody = extractDelimited(source.slice(secondStart), marker)
  return {
    desktop: commandNamesFromHandler(desktopBody),
    mobile: commandNamesFromHandler(mobileBody),
  }
}

type PluginContract = {
  buildCommands: Set<string>
  defaultPermissions: Set<string>
  generatedPermissions: Set<string>
  handlers: Set<string>
  id: string
}

function pluginContracts(): PluginContract[] {
  return readdirSync(PLUGINS_ROOT, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && entry.name.startsWith('tauri-plugin-')
    )
    .flatMap((entry) => {
      const root = join(PLUGINS_ROOT, entry.name)
      const libPath = join(root, 'src/lib.rs')
      const buildPath = join(root, 'build.rs')
      try {
        const libSource = read(libPath)
        const id = libSource.match(/Builder::new\("([^"]+)"\)/)?.[1]
        if (!id) return []

        const handlerBody = extractDelimited(
          libSource,
          '.invoke_handler(tauri::generate_handler!'
        )
        const buildSource = read(buildPath)
        const buildBody =
          buildSource.match(/const COMMANDS[^=]*=\s*&\[(.*?)\];/s)?.[1] ??
          buildSource.match(
            /tauri_plugin::Builder::new\(\s*&\[(.*?)\]\s*\)/s
          )?.[1]
        if (!buildBody) throw new Error(`Missing COMMANDS in ${buildPath}`)
        const defaultSource = read(join(root, 'permissions/default.toml'))
        const generatedRoot = join(root, 'permissions/autogenerated/commands')

        return [
          {
            id,
            handlers: commandNamesFromHandler(handlerBody),
            buildCommands: new Set(
              [...buildBody.matchAll(/"([a-z0-9_]+)"/g)].map(
                (match) => match[1]
              )
            ),
            defaultPermissions: new Set(
              [...defaultSource.matchAll(/"allow-([a-z0-9-]+)"/g)].map(
                (match) => match[1].replaceAll('-', '_')
              )
            ),
            generatedPermissions: new Set(
              readdirSync(generatedRoot)
                .filter((file) => extname(file) === '.toml')
                .map((file) => basename(file, '.toml'))
            ),
          },
        ]
      } catch {
        return []
      }
    })
}

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    if (
      entry.isDirectory() &&
      !['dist', 'node_modules', 'test', '__tests__'].includes(entry.name)
    ) {
      return sourceFiles(path)
    }
    if (
      entry.isFile() &&
      ['.ts', '.tsx'].includes(extname(entry.name)) &&
      !entry.name.includes('.test.')
    ) {
      return [path]
    }
    return []
  })
}

function frontendInvokeCommands(): Map<string, Set<string>> {
  const roots = [
    join(REPO_ROOT, 'web-app/src'),
    join(REPO_ROOT, 'extensions'),
    ...readdirSync(PLUGINS_ROOT)
      .filter((name) => name.startsWith('tauri-plugin-'))
      .map((name) => join(PLUGINS_ROOT, name, 'guest-js')),
  ]
  const commands = new Map<string, Set<string>>()

  for (const root of roots) {
    let files: string[]
    try {
      files = sourceFiles(root)
    } catch {
      continue
    }
    for (const file of files) {
      const source = read(file)
      const pattern = /\binvoke(?:<[^;()]*>)?\s*\(\s*(['"`])([^'"`${}]+)\1/g
      for (const match of source.matchAll(pattern)) {
        const command = match[2]
        const origins = commands.get(command) ?? new Set<string>()
        origins.add(file.slice(REPO_ROOT.length + 1))
        commands.set(command, origins)
      }
    }
  }
  return commands
}

function configuredDesktopPluginDefaults(): Set<string> {
  const config = JSON.parse(read(join(TAURI_ROOT, 'tauri.conf.json'))) as {
    app: { security: { capabilities: string[] } }
  }
  const granted = new Set<string>()
  for (const capability of config.app.security.capabilities) {
    const path = join(TAURI_ROOT, 'capabilities', `${capability}.json`)
    const parsed = JSON.parse(read(path)) as {
      permissions: Array<string | { identifier: string }>
    }
    for (const permission of parsed.permissions) {
      const identifier =
        typeof permission === 'string' ? permission : permission.identifier
      const match = identifier.match(/^([a-z0-9-]+):default$/)
      if (match) granted.add(match[1])
    }
  }
  return granted
}

describe('Tauri IPC contract', () => {
  const appHandlers = appHandlerSets()
  const allAppHandlers = new Set([
    ...appHandlers.desktop,
    ...appHandlers.mobile,
  ])
  const plugins = pluginContracts()
  const pluginById = new Map(plugins.map((plugin) => [plugin.id, plugin]))
  const frontendInvokes = frontendInvokeCommands()

  it('keeps the documented desktop/mobile handler split', () => {
    expect(
      sorted(setDifference(appHandlers.desktop, appHandlers.mobile))
    ).toEqual(sorted(EXPECTED_DESKTOP_ONLY))
    expect(
      sorted(setDifference(appHandlers.mobile, appHandlers.desktop))
    ).toEqual(sorted(EXPECTED_MOBILE_ONLY))
  })

  it('registers every frontend app command', () => {
    const routeCommands = Routes.map(({ route }) => routeToCommand(route))
    const directCommands = [...frontendInvokes.keys()].filter(
      (command) => !command.startsWith('plugin:')
    )
    const missingRoutes = routeCommands.filter(
      (command) =>
        !allAppHandlers.has(command) && !KNOWN_NON_TAURI_ROUTES.has(command)
    )
    const missingDirect = directCommands.filter(
      (command) =>
        !allAppHandlers.has(command) &&
        !KNOWN_UNREGISTERED_APP_COMMANDS.has(command)
    )
    expect({
      direct: sorted(new Set(missingDirect)),
      routes: sorted(new Set(missingRoutes)),
    }).toEqual({ direct: [], routes: [] })
  })

  it('keeps plugin handlers, codegen, and permissions aligned', () => {
    const errors: string[] = []
    expect(sorted(pluginById.keys())).toEqual(EXPECTED_PLUGIN_IDS)
    for (const plugin of plugins) {
      for (const command of plugin.handlers) {
        if (!plugin.buildCommands.has(command)) {
          errors.push(`${plugin.id}: build.rs missing ${command}`)
        }
        if (!plugin.generatedPermissions.has(command)) {
          errors.push(`${plugin.id}: generated permission missing ${command}`)
        }
        if (!plugin.defaultPermissions.has(command)) {
          errors.push(`${plugin.id}: default permission missing ${command}`)
        }
      }
    }
    expect(errors.sort()).toEqual([])
  })

  it('authorizes every frontend plugin command', () => {
    const grantedPlugins = configuredDesktopPluginDefaults()
    const errors: string[] = []
    for (const command of frontendInvokes.keys()) {
      const match = command.match(/^plugin:([a-z0-9-]+)\|([a-z0-9_]+)$/)
      if (!match) continue
      const [, pluginId, commandName] = match
      const plugin = pluginById.get(pluginId)
      if (!plugin) {
        errors.push(`${command}: plugin is not registered`)
        continue
      }
      if (!plugin.handlers.has(commandName)) {
        errors.push(`${command}: handler is not registered`)
      }
      if (!plugin.defaultPermissions.has(commandName)) {
        errors.push(`${command}: default permission is missing`)
      }
      if (!grantedPlugins.has(pluginId)) {
        errors.push(`${command}: plugin default is absent from capabilities`)
      }
    }
    expect(errors.sort()).toEqual([])
  })
})
