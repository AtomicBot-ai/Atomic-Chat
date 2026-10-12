#!/usr/bin/env node
// Sets `version` in the `[package]` table of a Cargo.toml, and nothing else:
// dependency versions, comments and formatting stay byte-for-byte.
//
//   node scripts/set-cargo-package-version.mjs src-tauri/Cargo.toml 2.2.1
//
// The release workflow used `cargo install ctoml` for this one line, which
// compiled a crate in every build job before the build could start.
import { readFileSync, writeFileSync } from 'node:fs'

const [path, version] = process.argv.slice(2)
if (!path || !version) {
  console.error('usage: set-cargo-package-version.mjs <Cargo.toml> <version>')
  process.exit(2)
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`not a semver version: ${version}`)
  process.exit(2)
}

const text = readFileSync(path, 'utf8')
const lines = text.split('\n')
const start = lines.findIndex((line) => line.trim() === '[package]')
if (start === -1) {
  console.error(`${path}: no [package] table`)
  process.exit(1)
}
let end = lines.findIndex((line, i) => i > start && /^\s*\[/.test(line))
if (end === -1) end = lines.length

const versionLine = /^(\s*version\s*=\s*)"[^"]*"(.*)$/
const matches = []
for (let i = start + 1; i < end; i++)
  if (versionLine.test(lines[i])) matches.push(i)
if (matches.length !== 1) {
  console.error(
    `${path}: expected one version line in [package], found ${matches.length}`
  )
  process.exit(1)
}
lines[matches[0]] = lines[matches[0]].replace(versionLine, `$1"${version}"$2`)
writeFileSync(path, lines.join('\n'))
console.log(`${path}: [package] version = "${version}"`)
