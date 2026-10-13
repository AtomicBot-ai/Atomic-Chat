/** Reading generated media back out of a chat message's metadata. */

/** What a chat message remembers about a media file it generated. */
export type InlineMediaItem = {
  asset_id: string
  path: string
  mime: string
  media_type: 'image' | 'video' | 'audio' | 'model3d' | 'unknown'
  model_label?: string
  prompt?: string
}

export function inlineMediaOf(
  metadata: Record<string, unknown> | undefined
): InlineMediaItem[] {
  const media = (metadata as { media?: unknown } | undefined)?.media
  if (!Array.isArray(media)) return []
  return media.filter(
    (item): item is InlineMediaItem =>
      !!item && typeof item === 'object' && typeof item.path === 'string'
  )
}
