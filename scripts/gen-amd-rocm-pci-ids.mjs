#!/usr/bin/env node
// Generate the AMD PCI device id -> gfx target table used to gate the Windows
// ROCm backend, from two upstream sources instead of by hand:
//
//   1. AMD's HIP SDK for Windows system requirements page, which is the only
//      authority on which GPUs AMD actually supports on Windows and what LLVM
//      target (gfx....) each one is. Cards AMD marks unsupported are dropped:
//      the ROCm archive is ~980 MB and Vulkan is the working alternative, so a
//      card AMD itself does not stand behind is not worth the download.
//   2. `pci.ids` from pciutils, which is the canonical machine-readable list of
//      PCI device ids and their AMD codenames.
//
// Matching is by marketing model (e.g. "RX 7900 XTX", "W7900"). Once one board
// of a codename matches, every GPU device id carrying that codename inherits
// the gfx target -- that is how OEM and workstation variants of the same
// silicon get covered without AMD listing each one.
//
// Writes src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/amd_rocm_pci_ids.rs
//
// Usage:
//   node scripts/gen-amd-rocm-pci-ids.mjs
//   node scripts/gen-amd-rocm-pci-ids.mjs --check   # fail if regeneration would change it

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT = join(
  ROOT,
  'src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/amd_rocm_pci_ids.rs'
)

const ROCM_REQUIREMENTS_URL =
  'https://rocm.docs.amd.com/projects/install-on-windows/en/latest/reference/system-requirements.html'
const PCI_IDS_URL = 'https://pci-ids.ucw.cz/v2.2/pci.ids'
const AMD_PCI_VENDOR_ID = '1002'

// AMDGPU_TARGETS of the `windows-rocm` job in ggml-org/llama.cpp's release
// workflow (read at tag b10405). A gfx target outside this list has no code in
// the archive, so offering it would hand the user a build that aborts on load.
const UPSTREAM_AMDGPU_TARGETS = new Set([
  'gfx1010',
  'gfx1011',
  'gfx1012',
  'gfx1030',
  'gfx1031',
  'gfx1032',
  'gfx1033',
  'gfx1034',
  'gfx1035',
  'gfx1036',
  'gfx1100',
  'gfx1101',
  'gfx1102',
  'gfx1103',
  'gfx1150',
  'gfx1151',
  'gfx1152',
  'gfx1153',
  'gfx1200',
  'gfx1201',
])

// Model suffixes that are part of the board name rather than the next word of
// prose ("RX 7900 XT" vs "Radeon Pro W7800 48GB").
const MODEL_SUFFIXES = new Set([
  'XT',
  'XTX',
  'XTXH',
  'GRE',
  'M',
  'S',
  'D',
  'OEM',
  'LE',
])

// Words that say nothing about which board this is.
const BRAND_NOISE = new Set([
  'AMD',
  'RADEON',
  'GRAPHICS',
  'PRO',
  'AI',
  'DUAL',
  'SLOT',
])

// A bare model number is not identifying: "380" is both a Tonga board and a
// Ryzen AI Max SKU. A key must carry its product line, either as a leading `RX`
// or as a `W`/`V`/`R` + 4-digit part number.
const MODEL_NUMBER = /^\d{3,4}[A-Z]?$/
const PART_NUMBER = /^[WVR]\d{4}[A-Z]?$/

// pci.ids lists the non-graphics functions of the same silicon (audio, USB,
// bridges) under the same codename. They never show up as a Vulkan device, and
// inheriting a gfx target onto them would be nonsense.
const NON_GPU_FUNCTION = /\b(USB|Audio|HDMI|Bridge|Switch|Port|Controller)\b/i

function parseArgs(argv) {
  const out = {}
  for (const arg of argv) {
    if (arg.startsWith('--')) out[arg.slice(2)] = true
  }
  return out
}

function die(message) {
  process.stderr.write(`Error: ${message}\n`)
  process.exit(1)
}

/**
 * Reduces a board name to the tokens that identify the model, so AMD's names
 * ("AMD Radeon PRO W7900 Dual Slot") and pci.ids' names ("Navi 31 [Radeon Pro
 * W7900]") meet on the same key. Returns `null` for anything without a
 * recognisable product line — an unidentifiable name must not match, because a
 * false match assigns a gfx target to the wrong silicon.
 */
export function modelKey(name) {
  const tokens = name
    .replace(/[\u2122\u00ae]/g, '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((token) => token.toUpperCase())
    .filter((token) => !BRAND_NOISE.has(token))

  const suffixesFrom = (index) => {
    const key = []
    for (const token of tokens.slice(index)) {
      if (!MODEL_SUFFIXES.has(token)) break
      key.push(token)
    }
    return key
  }

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === 'RX' && MODEL_NUMBER.test(tokens[i + 1] ?? '')) {
      return ['RX', tokens[i + 1], ...suffixesFrom(i + 2)].join(' ')
    }
    if (PART_NUMBER.test(tokens[i])) {
      return [tokens[i], ...suffixesFrom(i + 1)].join(' ')
    }
  }
  return null
}

/**
 * Board revision markers are per-SKU, the codename is per-silicon. Strip the
 * former so "Navi 31", "Navi 31 XTXH" and "Navi 32 GL-XL" group correctly.
 */
export function codenameKey(name) {
  const tokens = name.split(/\s+/).filter(Boolean)
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1]
    if (/-/.test(last) || /^(XLE?|XTX?H?|GL|LE|XT)$/i.test(last)) {
      tokens.pop()
      continue
    }
    break
  }
  return tokens.join(' ')
}

/**
 * Every model name a pci.ids entry covers: `Navi 31 [Radeon RX 7900 XT/7900
 * XTX]` lists two boards, and only the first spells out its product line. The
 * later parts inherit that prefix, otherwise "7900 XTX" would be unidentifiable.
 */
export function expandModelNames(name) {
  const bracket = /\[(.+)\]/.exec(name)
  if (!bracket) return [name]
  const parts = bracket[1]
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
  const first = parts[0]?.split(/\s+/) ?? []
  const prefixEnd = first.findIndex((token) => /\d/.test(token))
  const prefix = prefixEnd > 0 ? first.slice(0, prefixEnd).join(' ') : ''
  return parts.map((part, index) =>
    index === 0 || !prefix || modelKey(part) ? part : `${prefix} ${part}`
  )
}

export function parseRocmTable(html) {
  const rows = []
  for (const row of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? []) {
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((cell) =>
      cell[1]
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .trim()
    )
    // Name | Architecture | LLVM target | Runtime | HIP SDK | [debugger]
    if (cells.length < 5) continue
    if (!/^gfx\d+$/.test(cells[2])) continue
    rows.push({
      name: cells[0],
      architecture: cells[1],
      gfx: cells[2],
      hipSdk: cells[4] === '\u2705',
    })
  }
  if (rows.length === 0) {
    die(`no GPU rows found at ${ROCM_REQUIREMENTS_URL} (page layout changed?)`)
  }
  return rows
}

export function parsePciIds(text) {
  const entries = []
  let inVendor = false
  for (const line of text.split('\n')) {
    if (/^[0-9a-f]{4}\s/.test(line)) {
      inVendor = line.startsWith(`${AMD_PCI_VENDOR_ID} `)
      continue
    }
    if (!inVendor) continue
    const device = /^\t([0-9a-f]{4})\s\s(.+)$/.exec(line)
    if (!device) continue
    const name = device[2].trim()
    if (NON_GPU_FUNCTION.test(name)) continue
    entries.push({
      id: Number.parseInt(device[1], 16),
      name,
      codename: codenameKey(name.replace(/\s*\[.*$/, '')),
      models: expandModelNames(name)
        .map(modelKey)
        .filter((key) => key !== null),
    })
  }
  if (entries.length === 0) die(`no AMD devices found in ${PCI_IDS_URL}`)
  return entries
}

/**
 * Resolves gfx per codename from the AMD rows, then applies it to every GPU
 * device id of that codename. Two rows disagreeing about one codename means the
 * grouping assumption broke, and a wrong gfx here is a 980 MB download that
 * cannot run — so that is fatal, not a warning.
 */
export function resolveDeviceIds(rocmRows, pciEntries) {
  const supported = rocmRows.filter((row) => row.hipSdk)
  const gfxByCodename = new Map()
  const matchedRows = new Set()

  for (const row of supported) {
    const key = modelKey(row.name)
    if (!key) continue
    for (const entry of pciEntries) {
      if (!entry.models.includes(key)) continue
      matchedRows.add(row.name)
      const previous = gfxByCodename.get(entry.codename)
      if (previous && previous.gfx !== row.gfx) {
        die(
          `codename "${entry.codename}" resolves to both ${previous.gfx} (${previous.name}) and ${row.gfx} (${row.name})`
        )
      }
      gfxByCodename.set(entry.codename, { gfx: row.gfx, name: row.name })
    }
  }

  const devices = []
  for (const entry of pciEntries) {
    const resolved = gfxByCodename.get(entry.codename)
    if (!resolved) continue
    if (!UPSTREAM_AMDGPU_TARGETS.has(resolved.gfx)) continue
    devices.push({ id: entry.id, gfx: resolved.gfx, name: entry.name })
  }
  devices.sort((left, right) => left.id - right.id)

  return {
    devices,
    unmatched: supported
      .map((row) => row.name)
      .filter((name) => !matchedRows.has(name)),
  }
}

export function renderRustTable({ devices, unmatched }) {
  const rows = devices
    .map(
      (device) =>
        `    (0x${device.id.toString(16).padStart(4, '0')}, "${device.gfx}"), // ${device.name}`
    )
    .join('\n')

  const unmatchedNote = unmatched.length
    ? `//
// Not covered, because pci.ids carries no board name matching AMD's row:
${unmatched.map((name) => `//   - ${name}`).join('\n')}
// These reach ROCm only through the manual backend picker.
`
    : ''

  return `// GENERATED by scripts/gen-amd-rocm-pci-ids.mjs -- do not edit by hand.
//
// AMD PCI device id -> LLVM gfx target, for GPUs that BOTH AMD supports on
// Windows and the upstream \`windows-rocm\` archive is compiled for. Windows has
// no \`/sys/class/kfd\`, so the PCI device id from Vulkan is the only gfx signal
// available before the binary runs.
//
// Sources:
//   ${ROCM_REQUIREMENTS_URL}
//   ${PCI_IDS_URL}
${unmatchedNote}pub const AMD_ROCM_WINDOWS_PCI_IDS: &[(u32, &str)] = &[
${rows}
];
`
}

async function fetchText(url) {
  const resp = await fetch(url, { headers: { 'User-Agent': 'atomic-chat-rocm-gen' } })
  if (!resp.ok) die(`${url} returned HTTP ${resp.status}`)
  return resp.text()
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const [html, pciIds] = await Promise.all([
    fetchText(ROCM_REQUIREMENTS_URL),
    fetchText(PCI_IDS_URL),
  ])

  const resolved = resolveDeviceIds(parseRocmTable(html), parsePciIds(pciIds))
  if (resolved.devices.length === 0) {
    die('resolved no device ids; refusing to write an empty ROCm gate')
  }
  for (const name of resolved.unmatched) {
    process.stderr.write(`Warning: no pci.ids match for AMD row "${name}"\n`)
  }

  const next = renderRustTable(resolved)
  const current = await readFile(OUTPUT, 'utf8').catch(() => null)
  if (current === next) {
    process.stderr.write(`Table is up to date (${resolved.devices.length} devices)\n`)
    return
  }
  if (args.check) {
    die(
      `${OUTPUT.slice(ROOT.length + 1)} is stale; run \`make gen-amd-rocm-pci-ids\``
    )
  }
  await writeFile(OUTPUT, next)
  process.stderr.write(
    `Wrote ${resolved.devices.length} device ids to ${OUTPUT.slice(ROOT.length + 1)}\n`
  )
}

// Importable for unit tests; only the CLI path performs I/O.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => die(err.message))
}
