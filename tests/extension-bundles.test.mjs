/**
 * The extensions that talk to `atomic-chat-core` still bundle into something that loads.
 *
 * Unit tests import extension sources through Vitest, which never runs the production bundler. A
 * bundle can therefore pass every test and still fail the moment the app imports it: rolldown
 * 1.0.0-beta.1 dropped `createCoreRuntime` from the upstream extension because its adapter used
 * `export type { … } from` on the same module, and the webview threw `Can't find variable:
 * createCoreRuntime` and stayed black. This builds each extension in memory with its own config and
 * checks that every call to the shared core adapter has the function it calls.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXTENSIONS = [
  'llamacpp-extension',
  'llamacpp-upstream-extension',
  'mlx-extension',
  'foundation-models-extension',
]

for (const extension of EXTENSIONS) {
  test(`${extension} bundles the shared core adapter it calls`, async (t) => {
    const dir = join(ROOT, 'extensions', extension)
    const rolldownEntry = join(dir, 'node_modules', 'rolldown', 'dist', 'esm', 'index.mjs')
    if (!existsSync(rolldownEntry)) {
      t.skip(`${extension}: dependencies are not installed (run yarn install in extensions/)`)
      return
    }
    const { rolldown } = await import(pathToFileURL(rolldownEntry).href)
    const { default: config } = await import(pathToFileURL(join(dir, 'rolldown.config.mjs')).href)
    const previous = process.cwd()
    process.chdir(dir)
    try {
      const { output: _output, ...input } = config
      const bundle = await rolldown({ ...input, logLevel: 'silent' })
      const { output } = await bundle.generate({ format: 'esm' })
      const code = output.map((chunk) => chunk.code ?? '').join('\n')
      assert.match(code, /createCoreRuntime\(/, `${extension} no longer calls the core adapter`)
      assert.match(
        code,
        /function createCoreRuntime\(/,
        `${extension} calls createCoreRuntime but the bundle does not define it`
      )
    } finally {
      process.chdir(previous)
    }
  })
}
