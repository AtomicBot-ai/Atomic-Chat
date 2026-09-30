import type { UpdateBannerHighlight } from '@/containers/UpdateBanner'

/**
 * Sections of a generated release body that carry no product news. Matched
 * case-insensitively against the heading text with emoji and punctuation
 * stripped, so `## 🙏 Contributors` and `## Full Changelog` both drop out.
 *
 * The generator's heading set lives in `scripts/release-notes/generate.py`.
 */
const SKIPPED_SECTIONS = [
  'contributors',
  'full changelog',
  'new contributors',
  'whats changed',
]

/** Default number of bullets the banner shows before collapsing the rest. */
export const RELEASE_HIGHLIGHT_LIMIT = 4

export interface ParsedReleaseHighlights {
  /** Bullets to render, already truncated to the limit. */
  items: UpdateBannerHighlight[]
  /** Bullets that did not fit. `0` when everything is shown. */
  remaining: number
}

const EMPTY: ParsedReleaseHighlights = { items: [], remaining: 0 }

/** Strips the markdown a release bullet realistically carries. */
function stripMarkdown(text: string): string {
  return text
    // `[label](url)` → `label`
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Inline code, bold and italics.
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
    .replace(/(^|[^_])_([^_]+)_/g, '$1$2')
    // Bare issue/PR references left over after link stripping.
    .replace(/\s*\(#\d+\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeHeading(text: string): string {
  return text
    .replace(/[^\p{Letter}\p{Number}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Splits one bullet into a bold headline and a muted continuation.
 *
 * Preference order, matching how our generated notes actually read:
 *   1. An explicit `**headline**` prefix — the author already made the call.
 *   2. The first sentence, when the bullet has more than one.
 *   3. The part before an em/en dash or a colon, which is how most single
 *      sentence bullets separate "what" from "why".
 *   4. The whole bullet, with no detail.
 */
export function splitHighlight(raw: string): UpdateBannerHighlight | null {
  const boldPrefix = /^\s*\*\*([^*]+)\*\*\s*(.*)$/.exec(raw)
  if (boldPrefix) {
    const headline = stripMarkdown(boldPrefix[1])
    const detail = stripMarkdown(boldPrefix[2])
    if (headline) return detail ? { headline, detail } : { headline }
  }

  const text = stripMarkdown(raw)
  if (!text) return null

  const sentence = /^(.+?[.!?])\s+(\S.*)$/.exec(text)
  if (sentence) {
    return { headline: sentence[1], detail: sentence[2] }
  }

  const separator = /^(.+?)\s+[—–-]\s+(\S.*)$/.exec(text)
  if (separator) {
    return { headline: separator[1], detail: separator[2] }
  }

  const colon = /^([^:]{3,}?):\s+(\S.*)$/.exec(text)
  if (colon) {
    return { headline: colon[1], detail: colon[2] }
  }

  return { headline: text }
}

/**
 * Turns a GitHub release body into the short bulleted preview the app-update
 * banner shows (ATO-533).
 *
 * Deliberately forgiving: release bodies are LLM-generated from git history
 * and occasionally arrive as the default GitHub-generated notes instead, so
 * anything unparseable yields an empty result and the banner simply renders
 * without a changelog block rather than showing garbage.
 */
export function parseReleaseHighlights(
  body: string | null | undefined,
  limit: number = RELEASE_HIGHLIGHT_LIMIT
): ParsedReleaseHighlights {
  if (!body || typeof body !== 'string') return EMPTY

  const collected: UpdateBannerHighlight[] = []
  let skipping = false

  for (const line of body.split(/\r?\n/)) {
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      skipping = SKIPPED_SECTIONS.includes(normalizeHeading(heading[1]))
      continue
    }
    if (skipping) continue

    // Top-level bullets only — any indentation means a nested item, which is a
    // detail of the one above it and would read as a duplicate in a four-line
    // preview. Both our generator and GitHub's default notes write top-level
    // bullets flush left.
    const bullet = /^[-*+]\s+(.*)$/.exec(line)
    if (!bullet) continue

    const highlight = splitHighlight(bullet[1])
    if (highlight) collected.push(highlight)
  }

  if (collected.length === 0) return EMPTY

  return {
    items: collected.slice(0, limit),
    remaining: Math.max(0, collected.length - limit),
  }
}
