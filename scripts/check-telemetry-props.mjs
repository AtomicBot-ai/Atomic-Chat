/**
 * Guard against PostHog property names that are globally typed by another
 * event.
 *
 * PostHog types a property once, project-wide, from the values it first sees.
 * `api_server_request.status` is an HTTP code, so `status` is a number
 * everywhere — and every string written to it reads back as null. That is
 * exactly what happened: `model_load`'s success/failed values were unreadable,
 * the Models & Errors tile read empty, and it was filed as an instrumentation
 * bug for six weeks before anyone found the collision.
 *
 * Three source comments warn about it (switchModel.ts, DownloadManegement.tsx,
 * services/models/default.ts). Comments do not fail a build, so this does:
 * event-specific names only (`load_status`, `download_status`, `step_status`,
 * `connect_result`).
 *
 * See docs/decisions/2026-08-17-rename-the-string-status-property-that-posthog-had-typed-numeric.md
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scanRoot = join(root, 'web-app', 'src')

/**
 * Names that must never be a bare event property.
 *
 * `status` is the proven collision. The rest are reserved pre-emptively: they
 * are generic enough that some future event will claim them with a different
 * type, and by then the damage is retroactive — PostHog will not re-type a
 * property, so the fix is always a rename plus a gap in the series.
 */
const DENIED_PROPS = new Set(['status', 'type', 'name', 'id', 'value'])

/** Call expressions whose first object-literal argument is an event payload. */
const CAPTURE_CALLS = ['posthog.capture(', 'queuedCapture(']

function sourceFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue
      out.push(...sourceFiles(full))
      continue
    }
    if (!/\.tsx?$/.test(entry)) continue
    if (/\.test\.tsx?$/.test(entry)) continue
    out.push(full)
  }
  return out
}

/**
 * Text of the balanced `{...}` payload starting at or after `from`, or null if
 * the call takes no object literal (e.g. a spread-only `compact(...)` result).
 */
function payloadAt(text, from) {
  let i = from
  let depth = 0
  let start = -1
  for (; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '{') {
      if (depth === 0) start = i
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start + 1, i)
    } else if (depth === 0 && ch === ')') {
      return null
    }
  }
  return null
}

/** Top-level `key:` names in an object-literal body, ignoring nested objects. */
function topLevelKeys(body) {
  const keys = []
  let depth = 0
  let line = ''
  for (const ch of body) {
    if (ch === '{' || ch === '[' || ch === '(') depth += 1
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1
    if (ch === ',' && depth === 0) {
      keys.push(line)
      line = ''
      continue
    }
    line += ch
  }
  keys.push(line)
  return keys
    .map((entry) => /^\s*(?:\/\/[^\n]*\n\s*)*([A-Za-z_$][\w$]*)\s*:/.exec(entry))
    .filter(Boolean)
    .map((match) => match[1])
}

const violations = []
for (const file of sourceFiles(scanRoot)) {
  const text = readFileSync(file, 'utf8')
  for (const call of CAPTURE_CALLS) {
    let at = text.indexOf(call)
    while (at !== -1) {
      const body = payloadAt(text, at + call.length)
      if (body) {
        for (const key of topLevelKeys(body)) {
          if (!DENIED_PROPS.has(key)) continue
          const line = text.slice(0, at).split('\n').length
          violations.push(`${relative(root, file)}:${line}  property \`${key}\``)
        }
      }
      at = text.indexOf(call, at + call.length)
    }
  }
}

if (violations.length > 0) {
  console.error('Reserved PostHog property names used in event payloads:\n')
  for (const violation of violations) console.error(`  ${violation}`)
  console.error(
    '\nPostHog types a property globally by its first observed values, so a' +
      '\nname another event already claimed reads back as null. Use an' +
      '\nevent-specific name (load_status, download_status, step_status,' +
      '\nconnect_result) instead.\n'
  )
  process.exit(1)
}

console.log('check-telemetry-props: no reserved property names in use')
