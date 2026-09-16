import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

// The Launch page and the CLI must offer the same agents in the same order: a user who configures
// Codex from the app and then runs `jan-cli launch codex` has to get the same provider written the
// same way. `integrations.ts` is the source of truth; the CLI's `launch --list --json` is compared
// against it here, the way the Rust catalog was compared by its own drift test.
//
// The three GUI editors in the web list keep their provider in IDE storage with no writable config
// file, so no CLI can configure them and they are expected to be absent.
const EDITORS = new Set(['vscode', 'jetbrains', 'xcode'])
const ROOT = new URL('..', import.meta.url).pathname
const CLI = join(ROOT, 'src-tauri/resources/bin', process.platform === 'win32' ? 'jan-cli.exe' : 'jan-cli')

/** Ids in `INTEGRATION_AGENTS`, in file order. Entries are indented four spaces. */
function webAppAgentIds() {
  const source = readFileSync(join(ROOT, 'web-app/src/constants/integrations.ts'), 'utf8')
  const ids = source
    .split('\n')
    .filter((line) => line.startsWith("    id: '"))
    .map((line) => line.slice("    id: '".length).split("'")[0])
    .filter((id) => !EDITORS.has(id))
  assert.ok(ids.length > 0, 'could not parse any ids out of integrations.ts')
  return ids
}

function cliCatalog() {
  const stdout = execFileSync(CLI, ['launch', '--list', '--json'], { encoding: 'utf8', timeout: 60_000 })
  const parsed = JSON.parse(stdout)
  assert.ok(Array.isArray(parsed) && parsed.length > 0, 'launch --list --json returned nothing')
  return parsed
}

test('the CLI offers exactly the agents the Launch page does, in the same order', () => {
  assert.deepEqual(
    cliCatalog().map((agent) => agent.id),
    webAppAgentIds(),
    'agent catalog drifted between integrations.ts and the CLI (order matters)'
  )
})

test('every CLI agent carries the fields the launcher needs', () => {
  for (const agent of cliCatalog()) {
    assert.equal(typeof agent.id, 'string')
    assert.equal(agent.id, agent.id.toLowerCase(), `${agent.id}: ids are lowercase`)
    assert.ok(agent.name?.length > 0, `${agent.id}: has a display name`)
    assert.ok(agent.bin?.length > 0, `${agent.id}: has a binary to probe`)
    assert.match(agent.docs_url, /^https:\/\//, `${agent.id}: docs link`)
    assert.equal(typeof agent.installed, 'boolean', `${agent.id}: reports detection`)
    assert.ok(['terminal', 'gui'].includes(agent.run_mode), `${agent.id}: run mode`)
    assert.ok(Array.isArray(agent.run_args), `${agent.id}: run args`)
    assert.equal(typeof agent.endpoint_with_prefix, 'boolean', `${agent.id}: endpoint rule`)
  }
})

test('the agents that append their own API path are not given the prefix', () => {
  const byId = new Map(cliCatalog().map((agent) => [agent.id, agent]))
  // Claude Code and Goose append `/v1` (Goose through OPENAI_BASE_PATH); handing them a prefixed
  // endpoint produces `/v1/v1` and every request 404s.
  assert.equal(byId.get('claude-code').endpoint_with_prefix, false)
  assert.equal(byId.get('goose').endpoint_with_prefix, false)
  assert.equal(byId.get('codex').endpoint_with_prefix, true)
})

test('the CLI in resources/bin is the core build it claims to be', () => {
  const version = execFileSync(CLI, ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim()
  assert.match(version, /^\d+\.\d+\.\d+/, 'jan-cli --version should print a semantic version')
  const pinned = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).atomicCore?.version
  const stamp = join(ROOT, 'src-tauri/resources/bin/atomic-chat-core-version.txt')
  // The stamp only exists after `yarn download:core`; a local build (ATOMIC_CORE_LOCAL) has none.
  if (pinned && existsSync(stamp)) {
    assert.equal(readFileSync(stamp, 'utf8').trim(), pinned, 'resources/bin holds a different core version')
    assert.equal(version, pinned, 'jan-cli reports a different version than the pinned core')
  }
})
