import { classifyMediaUrl } from './workspace-preview-kind'

/**
 * Media a tool result points at, found by walking the result. Two sources:
 * any http(s) URL whose path ends in an image or video extension, and typed
 * generation records (`{ type: 'video' | 'image', results: { rawUrl,
 * thumbnailUrl } }` or `{ type, result_url, thumbnail_url }` — the shape
 * Higgsfield's `job_status` / `jobs_wait` return), which also work for CDN
 * URLs that carry no extension. Strings that look like JSON are parsed first,
 * because agent-mode MCP outcomes carry `content` and `structuredContent` as
 * JSON strings.
 */
export type ToolMedia = {
  kind: 'image' | 'video'
  url: string
  /** Video poster frame; never listed as an image of its own. */
  poster?: string
}

/** Enough for a batch of variants; a gallery beyond this stops being useful. */
export const MAX_TOOL_MEDIA = 12
const MAX_DEPTH = 10
const URL_RE = /https?:\/\/[^\s"'<>()[\]]+/g
const TRAILING_PUNCTUATION = /[.,;:!?]+$/

const httpUrl = (value: unknown): string | undefined =>
  typeof value === 'string' && /^https?:\/\//.test(value) ? value : undefined

const firstUrl = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    const url = httpUrl(value)
    if (url) return url
  }
  return undefined
}

const looksLikeJson = (text: string): boolean => {
  const head = text.trimStart()
  return head.startsWith('{') || head.startsWith('[')
}

export function extractToolMedia(output: unknown): ToolMedia[] {
  const found = new Map<string, ToolMedia>()
  const posters = new Set<string>()

  const add = (media: ToolMedia) => {
    if (found.has(media.url) || posters.has(media.url)) return
    if (found.size >= MAX_TOOL_MEDIA) return
    if (media.poster) {
      posters.add(media.poster)
      found.delete(media.poster)
    }
    found.set(media.url, media)
  }

  const visit = (value: unknown, depth: number) => {
    if (value == null || depth > MAX_DEPTH) return

    if (typeof value === 'string') {
      if (looksLikeJson(value)) {
        try {
          visit(JSON.parse(value), depth + 1)
          return
        } catch {
          // Not JSON after all; scan it as text.
        }
      }
      for (const match of value.matchAll(URL_RE)) {
        const url = match[0].replace(TRAILING_PUNCTUATION, '')
        const kind = classifyMediaUrl(url)
        if (kind) add({ kind, url })
      }
      return
    }

    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }

    if (typeof value === 'object') {
      const record = value as Record<string, unknown>
      const typed =
        record.type === 'video' || record.type === 'image'
          ? record.type
          : undefined
      if (typed) {
        const results = (record.results ?? {}) as Record<string, unknown>
        const url = firstUrl(
          results.rawUrl,
          results.minUrl,
          record.result_url,
          record.url
        )
        if (url) {
          const poster =
            typed === 'video'
              ? firstUrl(results.thumbnailUrl, record.thumbnail_url)
              : undefined
          add({ kind: typed, url, poster })
        }
      }
      for (const child of Object.values(record)) visit(child, depth + 1)
    }
  }

  visit(output, 0)
  return [...found.values()]
}

/** Videos linked from a text block, for an inline player under the prose. */
export function extractTextVideos(text: string): ToolMedia[] {
  if (!/https?:\/\//.test(text)) return []
  return extractToolMedia(text).filter((item) => item.kind === 'video')
}
