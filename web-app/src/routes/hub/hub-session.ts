import type { ModelFormat } from '@/lib/model-card'

let searchQuery = ''

export function getHubSearchQuery() {
  return searchQuery
}

export function setHubSearchQuery(query: string) {
  searchQuery = query
}

/**
 * The format picked in the Hub during this launch. Never saved across launches: the Hub opens on
 * GGUF every time the app starts (owner, 2026-10-03), however it was left; within one launch,
 * coming back to the Hub keeps what was picked, as the search query above does.
 */
let hubFormat: ModelFormat | null = null

export function getHubFormat() {
  return hubFormat
}

export function setHubFormat(format: ModelFormat | null) {
  hubFormat = format
}
