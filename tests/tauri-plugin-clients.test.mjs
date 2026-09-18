// Every official Tauri plugin is two halves — a Rust crate and an npm client —
// that talk over IPC, and nothing but version discipline keeps them compatible.
// `@tauri-apps/plugin-http` sat at 2.5.0 for months while `Cargo.lock` moved
// the crate to 2.5.7: the two disagree on how a response body travels, so no
// body ever arrived over the plugin, and nothing failed loudly enough to be
// traced to it (ADR 2026-09-18, "Keep the HTTP plugin's JS client on the Rust
// plugin's version").
//
// Two checks. The HTTP pair must match exactly — its protocol has changed
// inside a patch range before. Every pair is also compared by what it puts on
// the wire: each crate ships the client written for it (`guest-js/index.ts`),
// and the installed client must send the same commands with the same argument
// names. That second check needs the crate sources Cargo has downloaded, and is
// skipped, loudly, on a machine that has none.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const lock = readFileSync(join(ROOT, 'src-tauri/Cargo.lock'), 'utf8')

/** Crate name → locked version. */
const crates = Object.fromEntries(
  [...lock.matchAll(/name = "(tauri-plugin-[a-z0-9-]+)"\nversion = "([^"]+)"/g)].map((m) => [m[1], m[2]])
)

/** Every package.json that may name a plugin client. */
const manifests = ['package.json', 'web-app/package.json', 'core/package.json']
  .concat(readdirSync(join(ROOT, 'extensions')).map((dir) => `extensions/${dir}/package.json`))
  .filter((file) => existsSync(join(ROOT, file)))

/** npm client name → [{ manifest, range }]. */
const clients = {}
for (const manifest of manifests) {
  const pkg = JSON.parse(readFileSync(join(ROOT, manifest), 'utf8'))
  for (const section of ['dependencies', 'devDependencies']) {
    for (const [name, range] of Object.entries(pkg[section] ?? {})) {
      if (name.startsWith('@tauri-apps/plugin-')) (clients[name] ??= []).push({ manifest, range })
    }
  }
}

const crateOf = (client) => client.replace('@tauri-apps/plugin-', 'tauri-plugin-')

/** The commands a client source sends, each with the sets of argument names it sends them with. */
function wireCalls(source) {
  const calls = new Map()
  const pattern = /invoke(?:<[^>]*>)?\(\s*['"](plugin:[a-z-]+\|[a-z_]+)['"]\s*(?:,\s*\{([^}]*)\})?/gs
  for (const [, command, body = ''] of source.matchAll(pattern)) {
    const names = [...body.replace(/\s+/g, ' ').matchAll(/([A-Za-z_]+)\s*(?::|,|$)/g)].map((m) => m[1])
    const key = [...new Set(names)].sort().join(',')
    calls.set(command, (calls.get(command) ?? new Set()).add(key))
  }
  return calls
}

/** The installed client as Node would find it from `manifest`: the nearest `node_modules` upwards. */
function installedClientSource(client, manifest) {
  const top = join(ROOT, '.')
  for (let dir = dirname(join(ROOT, manifest)); dir.startsWith(top); dir = dirname(dir)) {
    const file = join(dir, 'node_modules', client, 'dist-js/index.js')
    if (existsSync(file)) return readFileSync(file, 'utf8')
  }
  return null
}

function crateClientSource(crate, version) {
  const registry = join(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'registry/src')
  if (!existsSync(registry)) return null
  for (const index of readdirSync(registry)) {
    const file = join(registry, index, `${crate}-${version}`, 'guest-js/index.ts')
    if (existsSync(file)) return readFileSync(file, 'utf8')
  }
  return null
}

test('the HTTP plugin client is pinned to the exact version of the Rust plugin', () => {
  const locked = crates['tauri-plugin-http']
  assert.ok(locked, 'tauri-plugin-http is not in Cargo.lock')
  const users = clients['@tauri-apps/plugin-http'] ?? []
  assert.ok(users.length > 0, 'nothing depends on @tauri-apps/plugin-http any more; drop this test')
  for (const { manifest, range } of users) {
    assert.equal(range, locked, `${manifest} has @tauri-apps/plugin-http ${range}, Cargo.lock has tauri-plugin-http ${locked}`)
  }
})

for (const [client, users] of Object.entries(clients)) {
  const crate = crateOf(client)
  const locked = crates[crate]
  test(`${client} sends what ${crate} ${locked ?? '(absent)'} expects`, (t) => {
    assert.ok(locked, `${client} is a dependency but ${crate} is not in Cargo.lock`)
    const expected = crateClientSource(crate, locked)
    if (!expected) return t.skip(`no downloaded source for ${crate} ${locked}; run a cargo build first`)
    const expectedCalls = wireCalls(expected)
    for (const { manifest } of users) {
      const installed = installedClientSource(client, manifest)
      if (!installed) return t.skip(`${client} is not installed for ${manifest}`)
      const sent = wireCalls(installed)
      const differences = []
      for (const command of new Set([...expectedCalls.keys(), ...sent.keys()])) {
        const want = [...(expectedCalls.get(command) ?? [])].sort().join(' | ')
        const have = [...(sent.get(command) ?? [])].sort().join(' | ')
        if (want !== have) differences.push(`${command}: the crate's client sends {${want}}, the installed one {${have}}`)
      }
      assert.deepEqual(differences, [], `${manifest}: ${client} does not match ${crate} ${locked}`)
    }
  })
}
