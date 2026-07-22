/**
 * Tauri-only fix for the streamdown code-block download button.
 *
 * Streamdown's CodeBlockDownloadButton creates a Blob URL and clicks an
 * `<a download>` to save the file. WKWebView (macOS) and some Tauri
 * configurations on other platforms ignore the `download` attribute, so the
 * click silently does nothing. We intercept the click at the document level
 * and route it through Tauri's native save dialog + `write_file_sync`.
 */

import { invoke } from '@tauri-apps/api/core'

import { getServiceHub, isServiceHubInitialized } from '@/hooks/useServiceHub'
import { useThreads } from '@/hooks/useThreads'

const DOWNLOAD_BUTTON_SELECTOR =
  '[data-streamdown="code-block-download-button"]'
const CODE_BLOCK_SELECTOR = '[data-streamdown="code-block"]'
const CODE_BODY_SELECTOR = '[data-streamdown="code-block-body"]'

const LANG_TO_EXT: Record<string, string> = {
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

type CodeBlockPayload = {
  code: string
  language: string
}

const DEFAULT_FILE_BASENAME = 'file'

/**
 * Turn a project name into a safe filename stem: strip path separators and
 * characters that are illegal on common filesystems, collapse whitespace, and
 * trim. Returns `null` when nothing usable remains.
 */
const sanitizeFileBaseName = (name: string): string | null => {
  const cleaned = name
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > 0 ? cleaned : null
}

/**
 * Default filename stem for a generated file. Uses the current thread's project
 * name when available so downloads land as e.g. `My Project.py` instead of the
 * generic `file.py`.
 */
const getDefaultFileBaseName = (): string => {
  try {
    const projectName =
      useThreads.getState().getCurrentThread()?.metadata?.project?.name
    if (typeof projectName === 'string') {
      return sanitizeFileBaseName(projectName) ?? DEFAULT_FILE_BASENAME
    }
  } catch (error) {
    console.debug('[code-block-download] could not resolve project name:', error)
  }
  return DEFAULT_FILE_BASENAME
}

const extractCodeBlockPayload = (
  button: Element,
): CodeBlockPayload | null => {
  const block = button.closest(CODE_BLOCK_SELECTOR)
  if (!block) return null

  const body = block.querySelector(CODE_BODY_SELECTOR)
  if (!body) return null

  const language = (
    body.getAttribute('data-language') ??
    block.getAttribute('data-language') ??
    'text'
  )
    .trim()
    .toLowerCase()

  const codeEl = body.querySelector('code')
  if (!codeEl) return null

  // Streamdown wraps each line in a direct-child `<span class="block ...">`,
  // so iterating direct children preserves line breaks. Fall back to plain
  // textContent if the structure ever changes.
  const lineNodes = Array.from(codeEl.children)
  const code =
    lineNodes.length > 0
      ? lineNodes.map((node) => node.textContent ?? '').join('\n')
      : (codeEl.textContent ?? '')

  return { code, language }
}

/**
 * Generic text save through Tauri's native save dialog + `write_file_sync`.
 * Used for code blocks and table exports (csv/markdown).
 */
const saveTextViaTauri = async (
  content: string,
  defaultPath: string,
  ext: string,
  filterName: string,
): Promise<void> => {
  if (!isServiceHubInitialized()) {
    console.warn('[code-block-download] ServiceHub not initialized yet')
    return
  }

  const dialog = getServiceHub().dialog()
  const targetPath = await dialog.save({
    defaultPath,
    filters: [{ name: filterName, extensions: [ext] }],
  })
  if (!targetPath) return

  await invoke('write_file_sync', {
    args: [targetPath, content],
  })
}

const downloadViaTauri = async (
  payload: CodeBlockPayload,
): Promise<void> => {
  const ext = LANG_TO_EXT[payload.language] ?? 'txt'
  const defaultPath = `${getDefaultFileBaseName()}.${ext}`
  await saveTextViaTauri(
    payload.code,
    defaultPath,
    ext,
    payload.language || 'Text',
  )
}

/* ------------------------------------------------------------------ *
 * Table downloads (csv / markdown).
 *
 * Streamdown renders a "table-wrapper" with a download button that
 * offers CSV / Markdown. Its own save path is a Blob `<a download>`
 * click, which Tauri's webview ignores — so the click does nothing.
 * We intercept those clicks and route them through Tauri instead.
 * ------------------------------------------------------------------ */

/** Extract { headers, rows } from a rendered <table> element. */
const extractTable = (table: Element): { headers: string[]; rows: string[][] } => {
  const headers: string[] = []
  table.querySelectorAll('thead th').forEach((th) => {
    headers.push((th.textContent ?? '').trim())
  })
  const rows: string[][] = []
  table.querySelectorAll('tbody tr').forEach((tr) => {
    const cells: string[] = []
    tr.querySelectorAll('td').forEach((td) => {
      cells.push((td.textContent ?? '').trim())
    })
    rows.push(cells)
  })
  return { headers, rows }
}

const csvCell = (value: string): string => {
  if (value.includes('"') || value.includes(',') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

const tableToCsv = ({ headers, rows }: { headers: string[]; rows: string[][] }): string => {
  const lines = [headers, ...rows].map((row) => row.map(csvCell).join(','))
  return lines.join('\n')
}

const tableToMarkdown = ({ headers, rows }: { headers: string[]; rows: string[][] }): string => {
  const escape = (value: string) => value.replace(/\|/g, '\\|')
  const headerLine = `| ${headers.map(escape).join(' | ')} |`
  const sepLine = `| ${headers.map(() => '---').join(' | ')} |`
  const bodyLines = rows.map((row) => `| ${row.map(escape).join(' | ')} |`)
  return [headerLine, sepLine, ...bodyLines].join('\n')
}

let installed = false

/**
 * Install once at app boot. Safe to call repeatedly — subsequent calls are
 * no-ops.
 */
export const installCodeBlockDownloadHandler = (): void => {
  if (installed) return
  if (typeof document === 'undefined') return
  installed = true

  document.addEventListener(
    'click',
    (event) => {
      const target = event.target
      if (!(target instanceof Element)) return

      // Streamdown table downloads: the "Download table as CSV / Markdown"
      // menu buttons create a Blob `<a download>` that Tauri's webview
      // ignores. Intercept and route through Tauri's save dialog.
      const menuBtn = target.closest('button')
      if (menuBtn) {
        const title = menuBtn.getAttribute('title') ?? ''
        const m = title.match(/Download table as (CSV|Markdown)/i)
        if (m) {
          event.preventDefault()
          event.stopPropagation()
          const format = m[1].toLowerCase() === 'csv' ? 'csv' : 'md'
          const wrapper = menuBtn.closest('[data-streamdown="table-wrapper"]')
          const table = wrapper?.querySelector('table')
          if (table) {
            const { headers, rows } = extractTable(table)
            const content =
              format === 'csv'
                ? tableToCsv({ headers, rows })
                : tableToMarkdown({ headers, rows })
            void saveTextViaTauri(
              content,
              `table.${format}`,
              format,
              format.toUpperCase(),
            ).catch((error) => {
              console.error('[table-download] save failed:', error)
            })
          }
          return
        }
      }

      const button = target.closest(DOWNLOAD_BUTTON_SELECTOR)
      if (!button) return

      event.preventDefault()
      event.stopPropagation()

      const payload = extractCodeBlockPayload(button)
      if (!payload) {
        console.warn(
          '[code-block-download] could not extract code from block',
        )
        return
      }

      void downloadViaTauri(payload).catch((error) => {
        console.error('[code-block-download] save failed:', error)
      })
    },
    { capture: true },
  )
}
