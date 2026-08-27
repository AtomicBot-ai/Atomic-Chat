/**
 * Shell-like tokenization for the MCP "command line" input, without any shell
 * execution or expansion: no $VAR, glob, or ~ handling — tokens reach the
 * backend exactly as typed, matching what the old per-argument rows produced.
 */

export type ParseError = 'empty' | 'unterminated-quote' | 'trailing-backslash'

export type ParseResult =
  | { ok: true; command: string; args: string[] }
  | { ok: false; error: ParseError }

const isSpace = (ch: string) => ch === ' ' || ch === '\t'

export function parseCommandLine(input: string): ParseResult {
  const tokens: string[] = []
  let current = ''
  let hasCurrent = false
  let i = 0
  const n = input.length

  while (i < n) {
    const ch = input[i]

    if (isSpace(ch)) {
      if (hasCurrent) {
        tokens.push(current)
        current = ''
        hasCurrent = false
      }
      i++
      continue
    }

    if (ch === "'") {
      // Single quotes are literal groups with no escapes inside (POSIX).
      const end = input.indexOf("'", i + 1)
      if (end === -1) return { ok: false, error: 'unterminated-quote' }
      current += input.slice(i + 1, end)
      hasCurrent = true
      i = end + 1
      continue
    }

    if (ch === '"') {
      // Inside double quotes only \" and \\ are escapes; any other backslash
      // stays literal so quoted Windows paths survive unchanged.
      i++
      let closed = false
      while (i < n) {
        const c = input[i]
        if (c === '\\' && (input[i + 1] === '"' || input[i + 1] === '\\')) {
          current += input[i + 1]
          i += 2
          continue
        }
        if (c === '"') {
          closed = true
          i++
          break
        }
        current += c
        i++
      }
      if (!closed) return { ok: false, error: 'unterminated-quote' }
      hasCurrent = true
      continue
    }

    if (ch === '\\') {
      if (i + 1 >= n) return { ok: false, error: 'trailing-backslash' }
      const next = input[i + 1]
      // Outside quotes a backslash escapes only whitespace, quotes, and
      // itself; before anything else it is literal (bare `C:\Users\foo` works).
      if (isSpace(next) || next === '"' || next === "'" || next === '\\') {
        current += next
        i += 2
      } else {
        current += ch
        i++
      }
      hasCurrent = true
      continue
    }

    current += ch
    hasCurrent = true
    i++
  }

  if (hasCurrent) tokens.push(current)
  if (tokens.length === 0) return { ok: false, error: 'empty' }

  const [command, ...args] = tokens
  return { ok: true, command, args }
}

// A token can be emitted raw only when re-parsing it yields the same token:
// no whitespace or quotes, and no backslash that parseCommandLine would treat
// as an escape (one before whitespace/quote/backslash, or a trailing one).
const needsQuoting = (token: string) =>
  token === '' || /[\s"']/.test(token) || /\\([\s"'\\]|$)/.test(token)

const quoteToken = (token: string) =>
  `"${token.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/**
 * Inverse of {@link parseCommandLine}: parseCommandLine(joinCommandLine(c, a))
 * returns exactly {c, a}, which is what makes the edit dialog lossless.
 */
export function joinCommandLine(command: string, args: string[]): string {
  return [command, ...args]
    .map((token) => (needsQuoting(token) ? quoteToken(token) : token))
    .join(' ')
    .trim()
}

/** `FOO=bar` — an env-style prefix the command field rejects. */
export function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)
}
