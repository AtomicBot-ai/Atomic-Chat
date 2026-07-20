/**
 * Helpers for rendering tool-call parameter previews.
 *
 * Tool inputs are shown as pretty-printed JSON. That works for small scalar
 * parameters, but any multiline string (e.g. the `content` of a file write)
 * gets its newlines escaped to literal `\n` and renders as one enormous
 * line. These helpers split such parameters out so the UI can render them as
 * real text blocks, and guess a syntax-highlight language from a sibling
 * path-like parameter.
 */

export type MultilineParam = {
  key: string
  value: string
}

export type SplitToolInput = {
  /** Input minus the extracted multiline params; null when nothing remains. */
  compact: Record<string, unknown> | null
  /** Params to render as dedicated text blocks, in original key order. */
  blocks: MultilineParam[]
}

/** Strings at least this long are pulled out even without a newline. */
const LONG_STRING_THRESHOLD = 400

/**
 * Split a tool input object into compact JSON-able params and multiline
 * string params that deserve their own block. Non-object inputs (including
 * arrays and partially streamed strings) yield no blocks so callers can fall
 * back to the plain JSON rendering.
 */
export function splitToolInput(input: unknown): SplitToolInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { compact: null, blocks: [] }
  }

  const compact: Record<string, unknown> = {}
  const blocks: MultilineParam[] = []

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (
      typeof value === 'string' &&
      (value.includes('\n') || value.length >= LONG_STRING_THRESHOLD)
    ) {
      blocks.push({ key, value })
    } else {
      compact[key] = value
    }
  }

  if (blocks.length === 0) {
    return { compact: null, blocks: [] }
  }

  return {
    compact: Object.keys(compact).length > 0 ? compact : null,
    blocks,
  }
}

// Extensions mapped to Shiki bundled language ids.
const EXTENSION_LANGUAGES: Record<string, string> = {
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  md: 'markdown',
  py: 'python',
  rs: 'rust',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sql: 'sql',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  go: 'go',
  java: 'java',
  swift: 'swift',
  kt: 'kotlin',
  rb: 'ruby',
  php: 'php',
  xml: 'xml',
  svg: 'xml',
}

/**
 * Best-effort language detection from the content itself. Used when the call
 * carries no path-like parameter to infer from — a `write_file` whose only
 * argument is `content` is common, and without this the text would fall back
 * to `markdown` and render essentially uncoloured.
 */
export function sniffLanguageFromContent(text: string): string | null {
  const head = text.slice(0, 500).trimStart()
  if (!head) return null

  if (/^<!doctype\s+html/i.test(head) || /^<html[\s>]/i.test(head))
    return 'html'
  if (/^<\?php/i.test(head)) return 'php'
  if (/^<\?xml[\s?]/i.test(head) || /^<svg[\s>]/i.test(head)) return 'xml'
  if (/^#!.*\b(bash|sh|zsh)\b/.test(head)) return 'bash'
  if (/^#!.*\bpython/.test(head)) return 'python'

  if (/^[{[]/.test(head)) {
    try {
      JSON.parse(text)
      return 'json'
    } catch {
      // Partial JSON is expected while a tool call is still streaming.
      if (/"[^"]*"\s*:/.test(head)) return 'json'
    }
  }

  if (/^(import|export)\s[^\n]*\sfrom\s+['"]/m.test(head)) return 'typescript'
  if (/^\s*(async\s+)?function\s+\w+|^\s*(const|let|var)\s+\w+\s*=/m.test(head))
    return 'javascript'
  if (/^\s*(def|class)\s+\w+[^\n]*:\s*$/m.test(head)) return 'python'
  if (/^\s*[.#@]?[\w-]+[^\n{]*\{[^}]*[\w-]+\s*:[^}]+;/m.test(head)) return 'css'
  if (/^#{1,6}\s+\S|^\s*[-*]\s+\S/m.test(head)) return 'markdown'

  return null
}

/**
 * Guess a highlight language for an extracted block. Prefers a path-like
 * sibling parameter (`path`, `file_path`, `filename`, …) because an explicit
 * extension is the strongest signal; otherwise sniffs the content. Falls back
 * to `markdown`, which renders arbitrary text acceptably.
 */
export function guessBlockLanguage(
  compact: Record<string, unknown> | null,
  sample?: string
): string {
  if (compact) {
    for (const [key, value] of Object.entries(compact)) {
      if (typeof value !== 'string') continue
      if (!/(^|_)(path|file|filename|dest|destination|target)$/i.test(key)) {
        continue
      }
      const match = value.match(/\.([A-Za-z0-9]+)$/)
      const language = match && EXTENSION_LANGUAGES[match[1].toLowerCase()]
      if (language) return language
    }
  }
  return (sample && sniffLanguageFromContent(sample)) || 'markdown'
}
