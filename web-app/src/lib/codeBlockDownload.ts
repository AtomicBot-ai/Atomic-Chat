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
import {
  extensionForLanguage,
  fileNameExtension,
  looksLikeFileName,
  matchesLanguage,
  sanitizeFileName,
  toDownloadFileName,
} from '@/lib/codeBlockFilename'

const DOWNLOAD_BUTTON_SELECTOR =
  '[data-streamdown="code-block-download-button"]'
const CODE_BLOCK_SELECTOR = '[data-streamdown="code-block"]'
const CODE_BODY_SELECTOR = '[data-streamdown="code-block-body"]'


type CodeBlockPayload = {
  code: string
  language: string
  /** Filename recovered from the block or its surroundings, when there is one. */
  fileName?: string
}

const DEFAULT_FILE_BASENAME = 'file'

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
      return sanitizeFileName(projectName) ?? DEFAULT_FILE_BASENAME
    }
  } catch (error) {
    console.debug('[code-block-download] could not resolve project name:', error)
  }
  return DEFAULT_FILE_BASENAME
}

/**
 * The filename a model printed as prose immediately above the block —
 * "**styles.css**", "`js/main.js`", or a bare line. `RenderMarkdown` puts an
 * explicit `data-code-filename` on blocks whose fence or first comment names
 * the file; this covers the remaining shape, where the name only exists in the
 * surrounding text.
 *
 * Streamdown renders each top-level markdown block as a direct child of its
 * root, so the previous sibling of the block's own top-level ancestor is that
 * line. It is only trusted when its extension matches the block's language.
 */
const fileNameFromPrecedingText = (
  block: Element,
  language: string,
): string | undefined => {
  let node: Element = block
  // Climb to the top-level block, i.e. the last ancestor before the container
  // that also holds the sibling paragraph.
  while (
    node.parentElement &&
    node.parentElement.parentElement &&
    !node.previousElementSibling
  ) {
    node = node.parentElement
  }

  const previous = node.previousElementSibling
  if (!previous) return undefined

  const text = (previous.textContent ?? '')
    .trim()
    .replace(/^[*_`#\s]+|[*_`:\s]+$/g, '')
  if (!text || !looksLikeFileName(text)) return undefined
  return matchesLanguage(text, language) ? text : undefined
}

/** The filename for this block, from the most explicit source available. */
const resolveFileName = (
  block: Element,
  language: string,
): string | undefined => {
  const declared = block
    .closest('[data-code-filename]')
    ?.getAttribute('data-code-filename')
  if (declared) return declared
  return fileNameFromPrecedingText(block, language)
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

  return { code, language, fileName: resolveFileName(block, language) }
}

const downloadViaTauri = async (
  payload: CodeBlockPayload,
): Promise<void> => {
  const languageExt = extensionForLanguage(payload.language)
  const defaultPath = toDownloadFileName(
    payload.fileName,
    languageExt,
    getDefaultFileBaseName(),
  )
  // Filter on the extension actually being saved: a recovered `main.d.ts` or
  // `app.min.js` must not be filtered as `.ts` / `.js`.
  const ext = fileNameExtension(defaultPath) || languageExt

  if (!isServiceHubInitialized()) {
    console.warn('[code-block-download] ServiceHub not initialized yet')
    return
  }

  const dialog = getServiceHub().dialog()
  const targetPath = await dialog.save({
    defaultPath,
    filters: [
      {
        name: payload.language || 'Text',
        extensions: [ext],
      },
    ],
  })
  if (!targetPath) return

  await invoke('write_file_sync', {
    args: [targetPath, payload.code],
  })
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
