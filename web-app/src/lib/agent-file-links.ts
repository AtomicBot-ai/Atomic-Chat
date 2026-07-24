import { agentPathBasename, isAbsoluteAgentPath } from './agent-path'

const FILE_LINK_OR_CODE = /(```[\s\S]*?```|`[^`\n]+`|\[[^\]]*\]\([^)]+\))/g
const FILE_LINK_PREFIX = 'https://atomic.local/open-file?path='

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
