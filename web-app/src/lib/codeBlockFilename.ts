/**
 * Recovering the real filename of a generated code block.
 *
 * The download button only ever knew the block's language, so every file
 * landed as `file.css` / `file.js` regardless of what the model called it
 * (issue #255). A model that writes out a project does name its files — in the
 * fence info string (```css styles.css), in a leading comment (`// js/main.js`),
 * or as a line of prose right above the block. These helpers recover that name;
 * `codeBlockDownload.ts` and `RenderMarkdown.tsx` try them in that order and
 * fall back to the previous behaviour when none of them match.
 */

/**
 * Code-fence language (as shiki reports it) to the extension the file should
 * be saved with. Lives here rather than next to the download handler so the
 * markdown renderer can consult it without pulling in the Tauri API.
 */
export const LANG_TO_EXT: Record<string, string> = {
  bash: 'sh',
  sh: 'sh',
  shell: 'sh',
  shellscript: 'sh',
  shellsession: 'sh',
  zsh: 'zsh',
  fish: 'fish',
  powershell: 'ps1',
  ps1: 'ps1',
  bat: 'bat',
  cmd: 'bat',
  python: 'py',
  py: 'py',
  ipython: 'py',
  javascript: 'js',
  js: 'js',
  jsx: 'jsx',
  typescript: 'ts',
  ts: 'ts',
  tsx: 'tsx',
  rust: 'rs',
  rs: 'rs',
  go: 'go',
  c: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  cxx: 'cpp',
  cc: 'cc',
  hpp: 'hpp',
  h: 'h',
  java: 'java',
  kotlin: 'kt',
  kt: 'kt',
  swift: 'swift',
  ruby: 'rb',
  rb: 'rb',
  php: 'php',
  html: 'html',
  xml: 'xml',
  svg: 'svg',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  json: 'json',
  jsonc: 'json',
  json5: 'json5',
  jsonl: 'jsonl',
  yaml: 'yaml',
  yml: 'yml',
  toml: 'toml',
  ini: 'ini',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  markdown: 'md',
  md: 'md',
  mdx: 'mdx',
  dockerfile: 'dockerfile',
  docker: 'dockerfile',
  makefile: 'makefile',
  make: 'makefile',
  nginx: 'conf',
  hcl: 'hcl',
  terraform: 'tf',
  tf: 'tf',
  prisma: 'prisma',
  proto: 'proto',
  protobuf: 'proto',
  vue: 'vue',
  svelte: 'svelte',
  astro: 'astro',
  lua: 'lua',
  r: 'r',
  perl: 'pl',
  pl: 'pl',
  csharp: 'cs',
  cs: 'cs',
  fsharp: 'fs',
  scala: 'scala',
  haskell: 'hs',
  hs: 'hs',
  elixir: 'ex',
  ex: 'ex',
  erlang: 'erl',
  erl: 'erl',
  ocaml: 'ml',
  clojure: 'clj',
  clj: 'clj',
  dart: 'dart',
  groovy: 'groovy',
  nim: 'nim',
  zig: 'zig',
  v: 'v',
  julia: 'jl',
  jl: 'jl',
  diff: 'diff',
  patch: 'patch',
  text: 'txt',
  txt: 'txt',
}

export const DEFAULT_EXTENSION = 'txt'

/** The extension a block of `language` should be saved with. */
export const extensionForLanguage = (language: string): string =>
  LANG_TO_EXT[language.trim().toLowerCase()] ?? DEFAULT_EXTENSION

/**
 * A plausible filename: optional directories, then a stem and a short
 * extension. Deliberately strict — anything looser starts matching prose like
 * "see example.com" or a sentence ending in an abbreviation.
 */
const FILENAME_PATTERN = /^[\w@~.+-]+(?:[/\\][\w@~.+-]+)*\.[A-Za-z0-9]{1,10}$/

/** `title="x"` / `filename='x'` / `file=x` / `name=x`, quotes optional. */
const META_KEY_VALUE_PATTERN =
  /\b(?:title|filename|file|name)\s*=\s*(?:"([^"]+)"|'([^']+)'|(\S+))/i

/**
 * Opening comment markers a model uses to label a file — line comments (`//`,
 * `#`, `--`, `;`) and the openers of block comments — with the closer, if any,
 * trimmed off the end.
 */
const LEADING_COMMENT_PATTERN =
  /^\s*(?:\/\/+|#+|--|;+|\/\*+|<!--)\s*(.*?)\s*(?:\*\/|-->)?\s*$/

const MAX_FILE_NAME_LENGTH = 120

/** Whether `value` looks like a filename rather than arbitrary text. */
export const looksLikeFileName = (value: string): boolean =>
  FILENAME_PATTERN.test(value)

/** The extension of `name`, lowercased, without the dot (`''` when absent). */
export const fileNameExtension = (name: string): string => {
  const base = name.split(/[/\\]/).pop() ?? name
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/**
 * The filename declared in a fenced block's info string, or `null`.
 *
 * `meta` is everything after the language on the fence line — remark keeps it
 * on the mdast node and `mdast-util-to-hast` forwards it as `node.data.meta`.
 * An explicit declaration is trusted as-is; the guessier sources below are not.
 */
export const parseFenceFilename = (meta?: string | null): string | null => {
  if (!meta) return null

  const keyValue = meta.match(META_KEY_VALUE_PATTERN)
  const named = keyValue?.[1] ?? keyValue?.[2] ?? keyValue?.[3]
  if (named && looksLikeFileName(named)) return named

  // A bare first token, optionally bracketed: ```js [js/main.js]
  const bare = meta.trim().split(/\s+/)[0]?.replace(/^[[(]|[\])]$/g, '')
  return bare && looksLikeFileName(bare) ? bare : null
}

/**
 * The filename from a comment on the code's first line, or `null`. Models
 * routinely open a file with `// src/main.js` even when the fence carries no
 * meta, which makes this the most reliable signal in practice.
 */
export const parseLeadingCommentFilename = (code: string): string | null => {
  const firstLine = code.split('\n', 1)[0]
  if (!firstLine) return null

  const comment = firstLine.match(LEADING_COMMENT_PATTERN)?.[1]
  if (!comment) return null

  // Take the last token so `// File: src/main.js` works as well as `// src/main.js`.
  const candidate = comment.split(/\s+/).pop()
  return candidate && looksLikeFileName(candidate) ? candidate : null
}

/**
 * The filename for a code block, or `null` when nothing trustworthy is found.
 *
 * A guessed name (leading comment, prose above the block) is only accepted
 * when its extension agrees with the block's language — otherwise a URL or a
 * stray abbreviation in a comment would rename the download.
 */
export const resolveCodeBlockFileName = (input: {
  meta?: string | null
  code: string
  language: string
}): string | null => {
  const fromFence = parseFenceFilename(input.meta)
  if (fromFence) return fromFence

  const guessed = parseLeadingCommentFilename(input.code)
  return guessed && matchesLanguage(guessed, input.language) ? guessed : null
}

/**
 * Whether `name`'s extension is the one this language saves as. Used to gate
 * the guessed sources; an unknown language has nothing to disagree with, so it
 * never vetoes a name.
 */
export const matchesLanguage = (name: string, language: string): boolean => {
  const lang = language.trim().toLowerCase()
  if (!lang || !(lang in LANG_TO_EXT)) return true
  const ext = fileNameExtension(name)
  return ext === LANG_TO_EXT[lang] || ext === lang
}

/**
 * Strip control characters and anything illegal on common filesystems.
 * Returns `null` when nothing usable is left.
 */
export const sanitizeFileName = (name: string): string | null => {
  const cleaned = name
    .split('')
    .map((character) => (character.charCodeAt(0) <= 31 ? ' ' : character))
    .join('')
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .trim()
  return cleaned.length > 0 ? cleaned.slice(0, MAX_FILE_NAME_LENGTH) : null
}

/**
 * The name to pre-fill in the save dialog. `raw` is a recovered filename (which
 * may carry directories the dialog would reject) and `fallbackStem` is the
 * previous behaviour — the project name, or `file`.
 */
export const toDownloadFileName = (
  raw: string | null | undefined,
  ext: string,
  fallbackStem: string
): string => {
  const basename = raw ? (raw.split(/[/\\]/).pop() ?? raw) : null
  const sanitized = basename ? sanitizeFileName(basename) : null
  if (!sanitized) return `${fallbackStem}.${ext}`
  return fileNameExtension(sanitized) ? sanitized : `${sanitized}.${ext}`
}
