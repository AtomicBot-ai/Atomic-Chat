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
import { execFileSync } from 'node:child_process'

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

/**
 * The extensions this platform's build packs, read from the root `build:extensions:<platform>`
 * script rather than listed here: its `--exclude` flags are the one place that decides, e.g. MLX
 * and Foundation Models only on macOS, TensorRT-LLM on Linux and Windows.
 */
function builtHere(platform = process.platform) {
  const scripts = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).scripts
  const script = scripts[`build:extensions:${platform}`] ?? ''
  const excluded = new Set([...script.matchAll(/--exclude\s+(\S+)/g)].map((m) => m[1]))
  return extensionPackages().filter((pkg) => !excluded.has(pkg.name))
}

test('Linux and Windows build the TensorRT-LLM extension, macOS does not', () => {
  // On Windows the extension ships in every build; the core hides it on ARM and until conf
  // publishes the Windows environment manifest (change add-tensorrt-llm-windows, design D14).
  const names = (platform) => builtHere(platform).map((pkg) => pkg.name)
  assert.ok(names('linux').includes('@janhq/tensorrt-llm-extension'))
  assert.ok(names('win32').includes('@janhq/tensorrt-llm-extension'))
  assert.ok(!names('darwin').includes('@janhq/tensorrt-llm-extension'))
})

test('Linux and Windows build the vLLM extension, macOS does not (change add-vllm-runtime)', () => {
  // The core offers vLLM wherever it offers TensorRT-LLM and hides it until conf publishes
  // `runtimes/vllm.json` (design D15); the build decides only the platforms.
  const names = (platform) => builtHere(platform).map((pkg) => pkg.name)
  assert.ok(names('linux').includes('@janhq/vllm-extension'))
  assert.ok(names('win32').includes('@janhq/vllm-extension'))
  assert.ok(!names('darwin').includes('@janhq/vllm-extension'))
})

test('Linux and Windows build the SGLang extension, macOS does not (change add-sglang-runtime)', () => {
  // Same platforms as vLLM; the core hides it until conf publishes `runtimes/sglang.json`
  // (design D9).
  const names = (platform) => builtHere(platform).map((pkg) => pkg.name)
  assert.ok(names('linux').includes('@janhq/sglang-extension'))
  assert.ok(names('win32').includes('@janhq/sglang-extension'))
  assert.ok(!names('darwin').includes('@janhq/sglang-extension'))
})

test('every desktop OS builds the Foundry Local extension (change add-foundry-local)', () => {
  // The core decides where the provider runs (design D7); the app ships it everywhere and hides it
  // where the core did not register it.
  const names = (platform) => builtHere(platform).map((pkg) => pkg.name)
  for (const platform of ['darwin', 'linux', 'win32']) {
    assert.ok(names(platform).includes('@janhq/foundry-local-extension'), platform)
  }
})

test('each extension this platform builds has a pre-install tarball under the name the installer looks for', () => {
  const tarballs = readdirSync(PRE_INSTALL).filter((name) => name.endsWith('.tgz'))

  const missing = builtHere()
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

/**
 * Bare specifiers a bundle still imports (`import … from "@tauri-apps/plugin-log"`), static or
 * dynamic. Relative and absolute paths and URLs are fine; JSDoc examples (`* import …`) are not
 * statements and are ignored.
 */
function bareImports(source) {
  const found = new Set()
  const statement = /^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm
  const dynamic = /\bimport\(\s*["']([^"']+)["']\s*\)/g
  for (const match of [...source.matchAll(statement), ...source.matchAll(dynamic)]) {
    const specifier = match[1] ?? match[2]
    if (!/^(\.{1,2}\/|\/|[a-z][a-z0-9+.-]*:)/i.test(specifier)) found.add(specifier)
  }
  return [...found]
}

test('the bundled extensions import nothing the webview would have to resolve by name', () => {
  // The app imports each extension straight from its asset URL, where a bare specifier cannot
  // resolve. Rolldown leaves an import bare when the package is missing from the extension's own
  // node_modules (a stale install), and the extension then fails to load at startup. Seen
  // 2026-10-23: Foundry Local's tarball kept `@tauri-apps/plugin-log` and the window stayed blank.
  const offenders = readdirSync(PRE_INSTALL)
    .filter((name) => name.endsWith('.tgz'))
    .flatMap((name) => {
      const source = execFileSync('tar', ['-xzOf', join(PRE_INSTALL, name), 'package/dist/index.js'], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      })
      return bareImports(source).map((specifier) => `${name}: ${specifier}`)
    })

  assert.deepEqual(offenders, [], 'rebuild these tarballs after `yarn install` in extensions/')
})

test('the bare-import check recognises what it must and only that', () => {
  assert.deepEqual(
    bareImports(
      [
        'import { error, info } from "@tauri-apps/plugin-log";',
        "export { x } from 'ulidx'",
        'const m = await import("fetch-retry")',
        "import './side-effect.js'",
        "* import { warn } from '@tauri-apps/plugin-log';",
        'import { a } from "./chunk.js"',
        'import("https://example.com/x.js")',
      ].join('\n')
    ),
    ['@tauri-apps/plugin-log', 'ulidx', 'fetch-retry']
  )
})

