#!/usr/bin/env node
/**
 * Stamp a build with a version number.
 *
 * Every test build a user downloads must carry its own version (tracker D34).
 * CI derives that number from the workflow run number — which increments once
 * per run, repo-wide for the workflow, so no two builds ever share a number and
 * nobody has to remember to bump anything. This script just writes that number
 * into the two files the app reads it from:
 *   src-tauri/tauri.conf.json  the installer and Windows' idea of the version
 *   web-app/package.json       the "v2.0.xx" shown in the app's sidebar
 *
 * Unlike bump-version.mjs it does not require the new number to be larger than
 * the committed one: a run number is not ordered against the placeholder that
 * sits in the files between builds. Only the top-level "version" line of each
 * file is touched, so formatting and nested settings stay as they are.
 *
 * Usage: node scripts/set-build-version.mjs x.y.z [--root <repo>]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const FILES = ['src-tauri/tauri.conf.json', 'web-app/package.json']
const VERSION = /^\d+\.\d+\.\d+$/

export function setVersion(version, { root } = {}) {
  const repo = root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  if (!VERSION.test(version)) {
    throw new Error(`"${version}" is not a version of the form x.y.z`)
  }
  // Read and check both before writing either, so a failure leaves both alone.
  const updates = FILES.map((rel) => {
    const file = path.join(repo, rel)
    const text = readFileSync(file, 'utf8')
    const line = /^(  "version":\s*")\d+\.\d+\.\d+(")/m
    if (!line.test(text)) {
      throw new Error(`Could not find the top-level version line in ${rel}`)
    }
    const updated = text.replace(line, `$1${version}$2`)
    if (JSON.parse(updated).version !== version) {
      throw new Error(`Updating ${rel} did not change its top-level version`)
    }
    return [file, updated]
  })
  for (const [file, updated] of updates) writeFileSync(file, updated)
  return version
}

function main(argv) {
  let root
  let version
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--root' && argv[index + 1]) {
      root = path.resolve(argv[++index])
    } else if (!version) {
      version = argv[index]
    } else {
      throw new Error(`Unexpected argument: ${argv[index]}`)
    }
  }
  if (!version) throw new Error('Usage: set-build-version.mjs x.y.z [--root <repo>]')
  console.log(setVersion(version, { root }))
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
