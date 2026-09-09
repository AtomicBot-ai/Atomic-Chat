import { agentPathBasename, isAbsoluteAgentPath } from './agent-path'

const FILE_LINK_OR_CODE = /(```[\s\S]*?```|`[^`\n]+`|\[[^\]]*\]\([^)]+\))/g
const CODE_ONLY = /(```[\s\S]*?```|`[^`\n]+`)/g
const FILE_LINK_PREFIX = 'https://atomic.local/open-file?path='
/**
 * A Markdown image the agent pointed at a local file, rewritten as a link so
 * the Markdown hardening (which blocks any image that is not an absolute
 * remote URL) leaves it alone; the `a` renderer turns it back into an image
 * or video player served through the asset protocol.
 */
const MEDIA_LINK_PREFIX = 'https://atomic.local/media?path='
/**
 * `![alt](src)` and `[label](href)` with an optional title, the destination
 * either bare or in angle brackets; group 1 is the `!` when it is an image.
 */
const MARKDOWN_LINK =
  /(!?)\[([^\]]*)\]\((?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"]*")?\)/g
/** A bare file URL in prose (GFM would autolink it, and harden block it). */
const BARE_FILE_URL = /file:\/\/[^\s)<>]+/g
/** Anything with a URL scheme (http, https, data, blob, asset, …). */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i

export type AgentFileReference = {
  path: string
  name?: string
}

function referenceNames(reference: AgentFileReference): string[] {
  const pathBasename = agentPathBasename(reference.path)
  return reference.name && reference.name !== pathBasename
    ? [pathBasename, reference.name]
    : [pathBasename]
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractPathValues(value: unknown, paths: Set<string>): void {
  if (!value || typeof value !== 'object') return

  for (const [key, child] of Object.entries(value)) {
    if (
      typeof child === 'string' &&
      (key === 'path' || key.endsWith('_path')) &&
      isAbsoluteAgentPath(child)
    ) {
      paths.add(child)
      continue
    }
    extractPathValues(child, paths)
  }
}

export function extractAgentToolPaths(parts: readonly unknown[]): string[] {
  const paths = new Set<string>()

  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    const candidate = part as { type?: unknown; input?: unknown }
    if (
      typeof candidate.type !== 'string' ||
      !candidate.type.startsWith('tool-')
    ) {
      continue
    }
    extractPathValues(candidate.input, paths)
  }

  return [...paths]
}

export function extractAgentAttachmentReferences(
  parts: readonly unknown[]
): AgentFileReference[] {
  const references: AgentFileReference[] = []

  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    const candidate = part as {
      type?: unknown
      url?: unknown
      filename?: unknown
    }
    if (
      candidate.type !== 'file' ||
      typeof candidate.url !== 'string' ||
      !isAbsoluteAgentPath(candidate.url)
    ) {
      continue
    }
    references.push({
      path: candidate.url,
      name:
        typeof candidate.filename === 'string' ? candidate.filename : undefined,
    })
  }

  return references
}

export function agentMediaPathFromHref(href: string): string | null {
  if (!href.startsWith(MEDIA_LINK_PREFIX)) return null
  try {
    return decodeURIComponent(href.slice(MEDIA_LINK_PREFIX.length))
  } catch {
    return null
  }
}

function joinAgentPath(base: string, relative: string): string {
  const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  const trimmedBase = base.replace(/[\\/]+$/, '')
  const trimmedRelative = relative.replace(/^(?:\.[\\/])+/, '')
  return `${trimmedBase}${separator}${trimmedRelative}`
}

export type AgentLocalPathContext = {
  /** The thread's primary workspace root; relative paths resolve against it. */
  workingDir?: string
  /** Files this message already knows about (attachments, tool paths). */
  references?: readonly (string | AgentFileReference)[]
}

/**
 * The absolute local path an agent-written image source refers to, or null
 * when it is remote (any URL scheme but `file:`) or cannot be resolved. A
 * bare name resolves first against the message's known files, then the
 * working directory.
 */
export function resolveAgentLocalPath(
  src: string,
  context: AgentLocalPathContext = {}
): string | null {
  let candidate = src.trim()
  if (!candidate) return null

  if (/^file:/i.test(candidate)) {
    try {
      const pathname = decodeURIComponent(new URL(candidate).pathname)
      candidate = /^\/[a-zA-Z]:/.test(pathname) ? pathname.slice(1) : pathname
    } catch {
      return null
    }
  } else if (HAS_SCHEME.test(candidate)) {
    return null
  } else {
    try {
      candidate = decodeURIComponent(candidate)
    } catch {
      // Keep the raw value; a stray percent sign is still a valid file name.
    }
  }

  if (isAbsoluteAgentPath(candidate)) return candidate

  const relative = candidate.replace(/^(?:\.[\\/])+/, '')
  const basename = agentPathBasename(relative)
  for (const reference of context.references ?? []) {
    const normalized =
      typeof reference === 'string' ? { path: reference } : reference
    if (
      agentPathBasename(normalized.path) === basename ||
      normalized.name === basename
    ) {
      return normalized.path
    }
  }

  if (context.workingDir) return joinAgentPath(context.workingDir, relative)
  return null
}

function isInlineMediaPath(path: string): boolean {
  const extension = agentPathBasename(path).split('.').at(-1)?.toLowerCase()
  return extension !== undefined && INLINE_MEDIA_EXTENSIONS.has(extension)
}

const INLINE_MEDIA_EXTENSIONS = new Set([
  'gif',
  'jpeg',
  'jpg',
  'png',
  'webp',
  'm4v',
  'mov',
  'mp4',
  'ogv',
  'webm',
])

/**
 * Rewrite Markdown that points at local files — `![alt](path)`, `[label](path)`
 * or `[label](file:///…)`, and bare `file://` URLs — so the Markdown hardening
 * (which blocks every non-remote image and every `file:` link) leaves them
 * alone. Images and videos the webview can decode become media links (see
 * MEDIA_LINK_PREFIX) and render inline; other files become open-file links.
 * Code spans and fences are untouched, as is anything that resolves to no
 * path, which then shows the usual blocked placeholder.
 */
export function linkAgentLocalMedia(
  content: string,
  context: AgentLocalPathContext = {}
): string {
  if (!content.includes('](') && !content.includes('file://')) return content

  const linkFor = (label: string, path: string): string => {
    const text = label.trim() || agentPathBasename(path)
    const prefix = isInlineMediaPath(path)
      ? MEDIA_LINK_PREFIX
      : FILE_LINK_PREFIX
    return `[${text}](${prefix}${encodeURIComponent(path)})`
  }

  return content
    .split(CODE_ONLY)
    .map((segment, index) => {
      if (index % 2 === 1) return segment
      return segment
        .replace(
          MARKDOWN_LINK,
          (
            match,
            bang: string,
            label: string,
            bracketed?: string,
            bare?: string
          ) => {
            const destination = bracketed ?? bare ?? ''
            if (
              destination.startsWith(MEDIA_LINK_PREFIX) ||
              destination.startsWith(FILE_LINK_PREFIX)
            ) {
              return match
            }
            const path = resolveAgentLocalPath(destination, context)
            if (!path) return match
            // An image of a non-media file cannot render either way; keep it
            // so the placeholder says what was meant.
            if (bang && !isInlineMediaPath(path)) return match
            return linkFor(label, path)
          }
        )
        .split(MARKDOWN_LINK_SPLIT)
        .map((piece, pieceIndex) => {
          if (pieceIndex % 2 === 1) return piece
          return piece.replace(BARE_FILE_URL, (url) => {
            const path = resolveAgentLocalPath(url, context)
            return path ? linkFor(agentPathBasename(path), path) : url
          })
        })
        .join('')
    })
    .join('')
}

/** Same shape as MARKDOWN_LINK, as a capturing split so links are skipped. */
const MARKDOWN_LINK_SPLIT =
  /(!?\[[^\]]*\]\((?:<[^>\n]+>|[^)\s]+)(?:\s+"[^"]*")?\))/g

export function agentFilePathFromHref(href: string): string | null {
  if (!href.startsWith(FILE_LINK_PREFIX)) return null

  try {
    return decodeURIComponent(href.slice(FILE_LINK_PREFIX.length))
  } catch {
    return null
  }
}

export function linkAgentFileReferences(
  content: string,
  fileReferences: readonly (string | AgentFileReference)[]
): string {
  const uniqueReferences = new Map<string, AgentFileReference>()
  for (const reference of fileReferences) {
    const normalized =
      typeof reference === 'string' ? { path: reference } : reference
    if (!uniqueReferences.has(normalized.path)) {
      uniqueReferences.set(normalized.path, normalized)
    } else if (normalized.name) {
      uniqueReferences.set(normalized.path, normalized)
    }
  }
  if (uniqueReferences.size === 0) return content

  const displayNamesByPath = new Map<string, string>()
  const nameCounts = new Map<string, number>()
  for (const reference of uniqueReferences.values()) {
    displayNamesByPath.set(
      reference.path,
      reference.name ?? agentPathBasename(reference.path)
    )
    for (const name of referenceNames(reference)) {
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1)
    }
  }

  const references = new Map<string, string>()
  for (const reference of uniqueReferences.values()) {
    references.set(reference.path, reference.path)
    for (const name of referenceNames(reference)) {
      if (nameCounts.get(name) === 1) references.set(name, reference.path)
    }
  }

  const pattern = new RegExp(
    [...references.keys()]
      .sort((left, right) => right.length - left.length)
      .map(escapeRegExp)
      .join('|'),
    'g'
  )

  return content
    .split(FILE_LINK_OR_CODE)
    .map((segment, index) => {
      if (index % 2 === 1) return segment
      return segment.replace(pattern, (label) => {
        const path = references.get(label)
        if (!path) return label
        const displayLabel =
          label === path
            ? (displayNamesByPath.get(path) ?? agentPathBasename(path))
            : label
        return `[${displayLabel}](${FILE_LINK_PREFIX}${encodeURIComponent(path)})`
      })
    })
    .join('')
}
