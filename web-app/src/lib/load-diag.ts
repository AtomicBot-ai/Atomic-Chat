/**
 * The core's machine-readable summary of a failed model load.
 *
 * `model_load.stderr_tail` is the only thing a failure carried, and on Windows
 * it is often empty or localized: an engine that dies before it prints, a
 * build the GPU cannot run, a fallback that was tried and failed too — all
 * read the same. The core now appends one last line to the load-failure
 * details:
 *
 *   atomic-core-diag {"exit_code":-1073741795,"stage":"spawn","backend":"cuda-12.4",…}
 *
 * Keys: `exit_code`, `signal`, `stage`, `backend`, `build`, `fallback_from`,
 * `fallback_to`, `fallback_ok`, `empty_stderr`. Older cores print no such line,
 * so every field is optional and a missing or garbled line yields `null`.
 */

import { scrubPii } from '@/lib/telemetry'

const DIAG_PREFIX = 'atomic-core-diag '

/** Longest string value kept: ids and enums fit, free-form text does not. */
const MAX_VALUE_LENGTH = 64

export type LoadDiag = {
  exit_code?: unknown
  signal?: unknown
  stage?: unknown
  backend?: unknown
  build?: unknown
  fallback_from?: unknown
  fallback_to?: unknown
  fallback_ok?: unknown
  empty_stderr?: unknown
}

function isDiagLine(line: string): boolean {
  return line.trim().startsWith(DIAG_PREFIX)
}

/**
 * The diag object from the LAST `atomic-core-diag ` line in `text`, or null
 * when there is none or it does not parse to a JSON object. Only the last line
 * counts: a fallback chain can print one per attempt, and the last one
 * describes how the load finally ended.
 */
export function parseLoadDiag(
  text: string | null | undefined
): LoadDiag | null {
  if (!text) return null
  const lines = text.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line.startsWith(DIAG_PREFIX)) continue
    try {
      const parsed: unknown = JSON.parse(line.slice(DIAG_PREFIX.length))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as LoadDiag)
        : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * `text` without its diag lines, or undefined when nothing else is left. The
 * diag is reported as properties of its own; left in the tail it would also
 * feed the text heuristics (`"signal"` reads as a crash, `"cuda"` as a CUDA
 * memory domain).
 */
export function stripLoadDiag(
  text: string | null | undefined
): string | undefined {
  if (!text) return undefined
  if (!text.includes(DIAG_PREFIX)) return text
  const kept = text
    .split(/\r?\n/)
    .filter((line) => !isDiagLine(line))
    .join('\n')
    .trim()
  return kept || undefined
}

function shortString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  // The core writes enums and build tags here; scrubbed anyway, so a path
  // that slips into a field cannot carry a username off the device.
  return scrubPii(trimmed).slice(0, MAX_VALUE_LENGTH)
}

function integer(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim()))
    return Number(value.trim())
  return null
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

export type LoadDiagProps = {
  exit_code: number | null
  /** A string even when the core sends a number, so the property keeps one type. */
  exit_signal: string | null
  startup_stage: string | null
  /** The backend the engine actually ran, which a fallback can change. */
  ran_backend: string | null
  engine_build: string | null
  fallback_from: string | null
  fallback_to: string | null
  fallback_ok: boolean | null
  empty_stderr: boolean | null
}

/**
 * `model_load` failure properties from a parsed diag. All null without one, so
 * the property set is the same on every failure and "the core said nothing"
 * stays distinguishable from a value.
 */
export function loadDiagProps(diag: LoadDiag | null): LoadDiagProps {
  return {
    exit_code: integer(diag?.exit_code),
    exit_signal: shortString(diag?.signal),
    startup_stage: shortString(diag?.stage),
    ran_backend: shortString(diag?.backend),
    engine_build: shortString(diag?.build),
    fallback_from: shortString(diag?.fallback_from),
    fallback_to: shortString(diag?.fallback_to),
    fallback_ok: bool(diag?.fallback_ok),
    empty_stderr: bool(diag?.empty_stderr),
  }
}
