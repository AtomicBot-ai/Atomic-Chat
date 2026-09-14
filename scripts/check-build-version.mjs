#!/usr/bin/env node
/**
 * Refuse to build a version number that was already built from a different
 * commit - the enforcement half of the user's rule that every build gets a new
 * version (tracker D34, Task 27).
 *
 * A successful test build tags the commit it built as `<prefix><version>`
 * (see .github/workflows/windows-test-build.yml). Before the next build this
 * reads the version from both version files and looks for that tag:
 *   - no tag           -> a new number: build it
 *   - tag on this HEAD -> the same commit again: rebuilding is fine
 *   - tag elsewhere    -> the number is taken: bump the version first
 *
 * Usage: node scripts/check-build-version.mjs [--prefix test-build/v] [--root <repo>]
 * Prints the version and exits 0 when the build may go ahead; otherwise prints
 * why to stderr and exits 1.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { readVersions } from './bump-version.mjs'

const DEFAULT_PREFIX = 'test-build/v'
const FIX = 'run make bump-version (or node scripts/bump-version.mjs), commit, push and build again'

function taggedCommit(root, tag) {
  const result = spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`], {
    cwd: root,
    encoding: 'utf8',
  })
  return result.status === 0 ? result.stdout.trim() : null
}

export function checkBuildVersion({ root, prefix = DEFAULT_PREFIX }) {
  let versions
  try {
    versions = readVersions(root)
  } catch (error) {
    return { ok: false, reason: `Could not read the version files: ${error.message}` }
  }
  const { tauri, web } = versions
  if (tauri !== web) {
    return {
      ok: false,
      reason: `The version files disagree: src-tauri/tauri.conf.json says ${tauri} but web-app/package.json says ${web}. Set them to the same new version, or ${FIX}.`,
    }
  }

  const tag = `${prefix}${tauri}`
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const built = taggedCommit(root, tag)
  if (built && built !== head) {
    return {
      ok: false,
      reason: `Version ${tauri} was already built from commit ${built.slice(0, 9)}. Every build needs a new version number: ${FIX}.`,
    }
  }
  return { ok: true, version: tauri, tag, alreadyTagged: Boolean(built) }
}

function main(argv) {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  let prefix = DEFAULT_PREFIX
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--root' && argv[index + 1]) {
      root = path.resolve(argv[++index])
    } else if (argv[index] === '--prefix' && argv[index + 1]) {
      prefix = argv[++index]
    } else {
      throw new Error(`Unknown or incomplete argument: ${argv[index]}`)
    }
  }
  const result = checkBuildVersion({ root, prefix })
  if (!result.ok) {
    console.error(result.reason)
    return 1
  }
  console.log(result.version)
  return 0
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
