import type { ToolUIPart } from 'ai'
import type { ToolPresentation } from './types'

type Translate = (key: string, options?: Record<string, unknown>) => string

/** Presentation-only: paths and parameters passed to tools are never changed. */
function fileTarget(
  presentation: ToolPresentation,
  t: Translate,
  location: boolean
) {
  const input = presentation.kind === 'generic' ? presentation.input : undefined
  const path =
    input && typeof input === 'object' && 'path' in input
      ? input.path
      : presentation.subtitle
  if (typeof path !== 'string' || !path.trim()) return t('toolCall.file')
  const normalized = path
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\/\/\?\//, '')
  const parts = normalized.split('/').filter(Boolean)
  const name = parts.at(-1) || t('toolCall.file')
  if (!location || parts.length < 2) return name
  let parent = parts.at(-2)!
  const home =
    /^(?:[A-Za-z]:)?\/(?:Users|home)\/[^/]+\/[^/]+$/i.test(normalized) ||
    parent === '~'
  if (home) parent = t('toolCall.locations.home')
  else if (['Desktop', 'Documents', 'Downloads'].includes(parent)) {
    parent = t(`toolCall.locations.${parent.toLowerCase()}`)
  }
  if (/^[A-Za-z]:$/.test(parent)) return name
  return t(
    parts.at(-2) === 'Desktop' ? 'toolCall.onDesktop' : 'toolCall.inFolder',
    { name, folder: parent }
  )
}

/** Do not let fallback titles expose raw identifiers or absolute paths. */
function humanTitle(title: string): string {
  return title
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|~\/|\/).*$/, '')
    .replace(/\b(?:[\w-]+\.)+([\w-]+)\b/g, '$1')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/^\w/, (letter) => letter.toUpperCase())
}

function hostname(url: string) {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

export function toolActivityLabel(
  toolName: string,
  presentation: ToolPresentation,
  state: ToolUIPart['state'],
  t: Translate
): string {
  const status =
    (state as string) === 'output-denied'
      ? 'denied'
      : state === 'output-error'
        ? 'error'
        : state === 'input-streaming' || state === 'input-available'
          ? 'running'
          : 'success'
  const action =
    presentation.kind === 'web_search_exa'
      ? 'search'
      : presentation.kind === 'web_fetch_exa'
        ? 'fetch'
        : (
            {
              'os.fs.write': 'write',
              'os.fs.read': 'read',
              'os.fs.list': 'list',
              'os.fs.glob': 'list',
              'os.fs.mkdir': 'mkdir',
              'os.shell.run': 'shell',
              'os.web.search': 'search',
              'os.web.fetch': 'fetch',
            } as Record<string, string>
          )[toolName]
  if (!action) {
    const title =
      humanTitle(presentation.title) ||
      humanTitle(toolName) ||
      t('toolCall.action')
    return t(`toolCall.fallback.${status}`, { title })
  }
  const label = t(`toolCall.actions.${action}.${status}`, {
    target:
      action === 'write' || action === 'read'
        ? fileTarget(presentation, t, action === 'write')
        : '',
  })
  const genericInput =
    presentation.kind === 'generic' &&
    presentation.input &&
    typeof presentation.input === 'object'
      ? (presentation.input as Record<string, unknown>)
      : undefined
  const webArgument =
    action === 'search' ? genericInput?.query : genericInput?.url
  const genericContext =
    typeof webArgument === 'string' ? webArgument : presentation.subtitle
  const context =
    presentation.kind === 'web_search_exa'
      ? presentation.query
      : presentation.kind === 'web_fetch_exa'
        ? presentation.urls?.map(hostname).filter(Boolean).join(', ')
        : action === 'search'
          ? genericContext
          : action === 'fetch' && genericContext
            ? hostname(genericContext)
            : undefined
  // Web context stays useful, but raw generic subtitles (commands, paths) stay
  // in the disclosure. A query can itself contain a local path.
  const safeContext = context
    ?.replace(/(?:[A-Za-z]:[\\/]|\\\\|~\/|\/).*$/, '')
    .trim()
  return safeContext
    ? t('toolCall.withContext', { label, context: safeContext })
    : label
}
