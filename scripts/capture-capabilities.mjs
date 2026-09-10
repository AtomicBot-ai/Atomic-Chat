#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'

export function parseCapabilityHelp(helpText) {
  const flags = new Set()
  for (const match of helpText.matchAll(
    /(?:^|[\s,])(--[a-z0-9][a-z0-9-]*)/gim
  )) {
    flags.add(match[1])
  }
  return [...flags].sort()
}

export function buildCapabilitySnapshot({
  provider,
  binary,
  helpText,
  source = 'live-binary',
  version = null,
}) {
  const bytes = readFileSync(binary)
  return {
    schema_version: 1,
    provider,
    source,
    binary: basename(binary),
    version,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    flags: parseCapabilityHelp(helpText),
  }
}

function usage() {
  console.error(
    'usage: node scripts/capture-capabilities.mjs <provider> <binary> <output.json> [version]'
  )
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , provider, binaryArg, outputArg, version = null] = process.argv
  if (!provider || !binaryArg || !outputArg) {
    usage()
    process.exitCode = 2
  } else {
    const binary = resolve(binaryArg)
    const helpText = execFileSync(binary, ['--help'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const snapshot = buildCapabilitySnapshot({
      provider,
      binary,
      helpText,
      version,
    })
    writeFileSync(resolve(outputArg), `${JSON.stringify(snapshot, null, 2)}\n`)
  }
}
