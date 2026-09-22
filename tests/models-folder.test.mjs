/**
 * The models folder the user chooses on the Models page (2026-09-14): "a simple
 * settings and file system to create and forward every downloaded model to a
 * user defined folder. Then user can select this folder as the default save and
 * read space for models".
 *
 * The extensions spell model paths under `<data folder>/llamacpp/models` in
 * dozens of places, so the redirect lives in Rust and every door into the file
 * system has to go through it. Losing any one of them quietly splits models
 * between two folders, so each is pinned here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(path.join(repoRoot, rel), 'utf8')

test('the app can read and change the models folder', () => {
  const lib = read('src-tauri/src/lib.rs')
  for (const command of ['get_models_folder', 'set_models_folder']) {
    const count = lib.split(`core::app::models_folder::${command},`).length - 1
    assert.equal(count, 2, `${command} must be registered in both command lists`)
  }
  const models = read('src-tauri/src/core/app/models.rs')
  assert.match(models, /pub models_folder: Option<String>/)
})

test('every file command follows the chosen models folder', () => {
  const helpers = read('src-tauri/src/core/filesystem/helpers.rs')
  assert.match(helpers, /redirect_for_app\(&app_handle/, 'resolve_path no longer redirects')

  const commands = read('src-tauri/src/core/filesystem/commands.rs')
  const body = (name) => {
    const start = commands.indexOf(`pub fn ${name}`)
    assert.ok(start >= 0, `${name} is missing`)
    const next = commands.indexOf('#[tauri::command]', start)
    return commands.slice(start, next < 0 ? undefined : next)
  }
  assert.match(body('join_path'), /redirect_for_app/, 'join_path no longer redirects')
  assert.match(body('write_yaml'), /redirect_for_app/, 'write_yaml no longer redirects')
  assert.match(body('read_yaml'), /redirect_for_app/, 'read_yaml no longer redirects')
  assert.match(body('rm'), /is_within_app_folders/, 'rm cannot delete in the models folder')
})

test('downloads are saved into the chosen models folder', () => {
  const downloads = read('src-tauri/src/core/downloads/helpers.rs')
  assert.match(downloads, /redirect_into_models_folder\(/)
  assert.match(downloads, /ensure_free_space\(\s*&receiving_folder/)

  const cli = read('src-tauri/src/core/cli/mod.rs')
  assert.match(cli, /cli_chosen_models_folder\(\)/, 'the command-line tool ignores the models folder')
})

test('the Models page offers the models folder setting', () => {
  const hub = read('web-app/src/routes/hub/index.tsx')
  assert.match(hub, /<ModelsFolderDialog \/>/)
  const labels = JSON.parse(read('web-app/src/locales/en/hub.json'))
  assert.equal(labels.modelsFolder?.button, 'Model settings')
})
