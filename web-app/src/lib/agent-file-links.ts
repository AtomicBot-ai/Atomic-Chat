import { agentPathBasename, isAbsoluteAgentPath } from './agent-path'

const FILE_LINK_OR_CODE = /(```[\s\S]*?```|`[^`\n]+`|\[[^\]]*\]\([^)]+\))/g
const FILE_LINK_PREFIX = 'https://atomic.local/open-file?path='
const MARKDOWN_LINK = /\[([^\]]*)\]\((https:\/\/atomic\.local\/open-file\?[^)\s]+)\)/g

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

function homeRelativePath(path: string): string | null {
  const match = path.match(/^\/(?:Users|home)\/[^/]+(\/.*)$/)
  return match ? `~${match[1]}` : null
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

export function agentFilePathFromHref(href: string): string | null {
  try {
    const url = new URL(href)
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'atomic.local' ||
      url.port !== '' ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/open-file' ||
      url.hash !== '' ||
      url.searchParams.size !== 1 ||
      url.searchParams.getAll('path').length !== 1
    ) {
      return null
    }

    // Decode explicitly instead of trusting URLSearchParams' forgiving
    // decoder. Invalid UTF-8/percent escapes must not become a native path.
    const rawPath = url.search.match(/^\?path=([^&]*)$/)?.[1]
    if (rawPath === undefined) return null
    const path = decodeURIComponent(rawPath.replace(/\+/g, '%20'))
    if (
      path.length === 0 ||
      path.includes('\0') ||
      !isAbsoluteAgentPath(path)
    ) {
      return null
    }

    return path
  } catch {
    return null
  }
}

export function normalizeAgentFileLinkLabels(content: string): string {
  return content
    .split(/(```[\s\S]*?```|`[^`\n]+`)/g)
    .map((segment, index) => {
      if (index % 2 === 1) return segment
      return segment.replace(MARKDOWN_LINK, (link, label, href) => {
        const path = agentFilePathFromHref(href)
        if (!path) return link
        const displayLabel = label.trim()
        if (displayLabel && !agentFilePathFromHref(displayLabel)) return link
        return `[${agentPathBasename(path)}](${href})`
      })
    })
    .join('')
}

export function containsAgentFileLink(content: string): boolean {
  return [...content.matchAll(MARKDOWN_LINK)].some((match) =>
    Boolean(agentFilePathFromHref(match[2]))
  )
}

export function linkAgentFileReferences(
  content: string,
  fileReferences: readonly (string | AgentFileReference)[]
): string {
  const normalizedContent = normalizeAgentFileLinkLabels(content)
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
  if (uniqueReferences.size === 0) return normalizedContent

  const displayNamesByPath = new Map<string, string>()
  const nameCounts = new Map<string, number>()
  const homeRelativeCounts = new Map<string, number>()
  for (const reference of uniqueReferences.values()) {
    displayNamesByPath.set(
      reference.path,
      reference.name ?? agentPathBasename(reference.path)
    )
    for (const name of referenceNames(reference)) {
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1)
    }
    const homeRelative = homeRelativePath(reference.path)
    if (homeRelative) {
      homeRelativeCounts.set(
        homeRelative,
        (homeRelativeCounts.get(homeRelative) ?? 0) + 1
      )
    }
  }

  const references = new Map<string, string>()
  const cleanPathLabels = new Set<string>()
  for (const reference of uniqueReferences.values()) {
    references.set(reference.path, reference.path)
    cleanPathLabels.add(reference.path)
    const homeRelative = homeRelativePath(reference.path)
    if (homeRelative && homeRelativeCounts.get(homeRelative) === 1) {
      references.set(homeRelative, reference.path)
      cleanPathLabels.add(homeRelative)
    }
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

  return normalizedContent
    .split(FILE_LINK_OR_CODE)
    .map((segment, index) => {
      if (index % 2 === 1) return segment
      return segment.replace(pattern, (label) => {
        const path = references.get(label)
        if (!path) return label
        const displayLabel =
          cleanPathLabels.has(label)
            ? (displayNamesByPath.get(path) ?? agentPathBasename(path))
            : label
        return `[${displayLabel}](${FILE_LINK_PREFIX}${encodeURIComponent(path)})`
      })
    })
    .join('')
}
