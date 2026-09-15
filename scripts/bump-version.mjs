#!/usr/bin/env node
/**
 * Give the next build a new version number (the user's standing rule of
 * 2026-09-14: every build that is committed, pushed and compiled gets one;
 * tracker D34, Task 27).
 *
 * The version lives in two files that always change together:
 *   src-tauri/tauri.conf.json  the installer and Windows' idea of the version
 *   web-app/package.json       the "v2.0.xx" shown in the app's sidebar
 *
 * With no arguments it adds one to the last number (2.0.37 -> 2.0.38).
 * `--to x.y.z` sets a version instead; it must be newer, because the Windows
 * installer only upgrades forwards. Only the top-level "version" line of each
 * file is touched, so formatting and nested settings stay as they are.
 *
 * Usage: node scripts/bump-version.mjs [--to x.y.z] [--root <repo>]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const FILES = {
  tauri: 'src-tauri/tauri.conf.json',
  web: 'web-app/package.json',
}
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/

export function readVersions(root) {
  const versions = {}
  for (const [key, rel] of Object.entries(FILES)) {
    versions[key] = JSON.parse(readFileSync(path.join(root, rel), 'utf8')).version
  }
  return versions
}

function compare(a, b) {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

export function bumpVersion({ root, to } = {}) {
  const { tauri, web } = readVersions(root)
  if (tauri !== web) {
    throw new Error(
      `The version files disagree: ${FILES.tauri} says ${tauri} but ${FILES.web} says ${web}. Set them to the same version by hand first.`
    )
  }
  if (!VERSION.test(tauri)) {
    throw new Error(`The current version "${tauri}" is not of the form x.y.z`)
  }

  let next
  if (to === undefined) {
    const [, major, minor, patch] = tauri.match(VERSION)
    next = `${major}.${minor}.${Number(patch) + 1}`
  } else {
    if (!VERSION.test(to)) {
      throw new Error(`"${to}" is not a version of the form x.y.z`)
    }
    if (compare(to, tauri) <= 0) {
      throw new Error(
        `${to} is not newer than ${tauri}; the Windows installer only upgrades to a newer version`
      )
    }
    next = to
  }

  // Read and check both before writing either, so a failure leaves both alone.
  const updates = Object.values(FILES).map((rel) => {
    const file = path.join(root, rel)
    const text = readFileSync(file, 'utf8')
    const line = new RegExp(`^(  "version":\\s*")${tauri.replaceAll('.', '\\.')}(")`, 'm')
    if (!line.test(text)) {
      throw new Error(`Could not find the top-level version line in ${rel}`)
    }
    const updated = text.replace(line, `$1${next}$2`)
    if (JSON.parse(updated).version !== next) {
      throw new Error(`Updating ${rel} did not change its top-level version`)
    }
    return [file, updated]
  })
  for (const [file, updated] of updates) writeFileSync(file, updated)
  return next
}

function main(argv) {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  let to
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--root' && argv[index + 1]) {
      root = path.resolve(argv[++index])
    } else if (argv[index] === '--to' && argv[index + 1]) {
      to = argv[++index]
    } else {
      throw new Error(`Unknown or incomplete argument: ${argv[index]}`)
    }
  }
  console.log(bumpVersion({ root, to }))
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
