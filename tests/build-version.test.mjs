/**
 * A test build refuses to start when its version number was already used by a
 * different commit - the enforcement half of the user's rule that every build
 * gets a new version (tracker D34, Task 27). A successful build leaves a tag
 * `test-build/v<version>` on the commit it built, so a later build can see
 * which commit a number belongs to. Rebuilding the same commit is allowed.
 */
import { strict as assert } from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { checkBuildVersion } from '../scripts/check-build-version.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(repoRoot, 'scripts', 'check-build-version.mjs')
const PREFIX = 'test-build/v'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

function writeVersions(root, tauri, web = tauri) {
  writeFileSync(
    path.join(root, 'src-tauri', 'tauri.conf.json'),
    `{\n  "productName": "Radium",\n  "version": "${tauri}"\n}\n`
  )
  writeFileSync(
    path.join(root, 'web-app', 'package.json'),
    `{\n  "name": "@janhq/web-app",\n  "version": "${web}"\n}\n`
  )
}

function commit(root, message) {
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', message)
  return git(root, 'rev-parse', 'HEAD')
}

function makeRepo(version = '2.0.38') {
  const root = mkdtempSync(path.join(tmpdir(), 'build-version-'))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.invalid')
  git(root, 'config', 'user.name', 'Build Version Test')
  mkdirSync(path.join(root, 'src-tauri'))
  mkdirSync(path.join(root, 'web-app'))
  writeVersions(root, version)
  commit(root, 'first build')
  return root
}

test('a version nobody has built yet may be built', () => {
  const root = makeRepo('2.0.38')
  try {
    assert.deepEqual(checkBuildVersion({ root, prefix: PREFIX }), {
      ok: true,
      version: '2.0.38',
      tag: 'test-build/v2.0.38',
      alreadyTagged: false,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rebuilding the commit that already carries the version is allowed', () => {
  const root = makeRepo('2.0.38')
  try {
    git(root, 'tag', 'test-build/v2.0.38')
    const result = checkBuildVersion({ root, prefix: PREFIX })
    assert.equal(result.ok, true)
    assert.equal(result.alreadyTagged, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a different commit with a version already built is refused, naming the fix', () => {
  const root = makeRepo('2.0.38')
  try {
    const first = git(root, 'rev-parse', 'HEAD')
    git(root, 'tag', 'test-build/v2.0.38')
    writeFileSync(path.join(root, 'change.txt'), 'new work\n')
    commit(root, 'more work, same version')

    const result = checkBuildVersion({ root, prefix: PREFIX })
    assert.equal(result.ok, false)
    assert.match(result.reason, /2\.0\.38/)
    assert.match(result.reason, new RegExp(first.slice(0, 9)))
    assert.match(result.reason, /make bump-version/)

    writeVersions(root, '2.0.39')
    commit(root, 'bump')
    assert.equal(checkBuildVersion({ root, prefix: PREFIX }).ok, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('two version files that disagree are refused', () => {
  const root = makeRepo('2.0.38')
  try {
    writeVersions(root, '2.0.38', '2.0.40')
    commit(root, 'half-edited')
    const result = checkBuildVersion({ root, prefix: PREFIX })
    assert.equal(result.ok, false)
    assert.match(result.reason, /disagree/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the command exits non-zero when refused and prints the version when not', () => {
  const root = makeRepo('2.0.38')
  try {
    const fine = spawnSync(process.execPath, [cli, '--root', root, '--prefix', PREFIX], { encoding: 'utf8' })
    assert.equal(fine.status, 0, fine.stderr)
    assert.equal(fine.stdout.trim(), '2.0.38')

    git(root, 'tag', 'test-build/v2.0.38')
    writeFileSync(path.join(root, 'change.txt'), 'new work\n')
    commit(root, 'more work, same version')
    const refused = spawnSync(process.execPath, [cli, '--root', root, '--prefix', PREFIX], { encoding: 'utf8' })
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /make bump-version/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the Windows test build checks its version, names the installer with it, and records it', () => {
  const workflow = readFileSync(path.join(repoRoot, '.github/workflows/windows-test-build.yml'), 'utf8')
  assert.match(
    workflow,
    /node scripts\/check-build-version\.mjs --prefix test-build\/v/,
    'the workflow no longer refuses a reused version number'
  )
  assert.match(
    workflow,
    /name: radium-windows-test-\$\{\{ steps\.version\.outputs\.version \}\}-/,
    'the installer artifact no longer carries its version'
  )
  assert.match(
    workflow,
    /git push origin "refs\/tags\/\$tag"/,
    'a successful build no longer records the version it used'
  )
  assert.match(workflow, /contents: write/, 'the build cannot push the version tag without contents: write')
})
