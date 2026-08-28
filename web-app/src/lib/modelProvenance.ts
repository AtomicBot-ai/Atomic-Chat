/**
 * Model provenance: which model/backend produced each assistant response.
 *
 * The chat transport records `modelId`, `providerId` and (when known)
 * `backend` in each assistant message's finish metadata (see
 * custom-chat-transport.ts). This module derives, at render time, where a
 * thread should show a provenance divider:
 * one "served by" marker at the first stamped response, and a "switched to"
 * marker wherever the recorded model/backend changes afterwards.
 *
 * Markers are anchored to the user prompt that led to the response, so the
 * divider reads "everything after this line came from X". When there is no
 * user prompt directly before the response (e.g. a regenerate with a
 * different model), the marker anchors to the assistant message itself.
 */

export type ModelProvenance = {
  modelId: string
  providerId: string
  /** Backend build tag (e.g. llama.cpp TurboQuant version) when available. */
  backend?: string
}

export type ProvenanceMarker = {
  kind: 'served' | 'switched'
  stamp: ModelProvenance
}

type ProvenanceMessage = {
  id: string
  role: string
  metadata?: unknown
}

/**
 * Defensive read of the provenance fields straight from message metadata.
 * Malformed or missing values are treated as absent, so history recorded
 * before these fields existed simply yields no stamp.
 */
export function readProvenanceStamp(
  metadata: unknown
): ModelProvenance | null {
  if (!metadata || typeof metadata !== 'object') return null
  const { modelId, providerId, backend } = metadata as Record<string, unknown>
  if (typeof modelId !== 'string' || modelId === '') return null
  if (typeof providerId !== 'string' || providerId === '') return null
  return {
    modelId,
    providerId,
    ...(typeof backend === 'string' && backend !== '' ? { backend } : {}),
  }
}

// The backend build is part of the identity on purpose: the same model served
// by a different backend build (e.g. a TurboQuant update mid-thread) is a
// provenance change worth surfacing. NUL-separated because model ids can
// contain spaces (local GGUF names), so a printable delimiter could collide.
const stampKey = (stamp: ModelProvenance) =>
  `${stamp.providerId}\u0000${stamp.modelId}\u0000${stamp.backend ?? ''}`

/**
 * Walk the thread once and return a map of message id → marker to render
 * above that message. Responses without recorded provenance (history older
 * than the finish-metadata fields) are skipped; the first stamped response
 * yields a "served" marker and every later change yields a "switched" one.
 */
export function computeProvenanceMarkers(
  messages: readonly ProvenanceMessage[]
): Map<string, ProvenanceMarker> {
  const markers = new Map<string, ProvenanceMarker>()
  let lastKey: string | null = null

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (message.role !== 'assistant') continue
    const stamp = readProvenanceStamp(message.metadata)
    if (!stamp) continue

    const key = stampKey(stamp)
    if (key === lastKey) continue

    const previous = messages[i - 1]
    const anchorId =
      previous && previous.role === 'user' ? previous.id : message.id
    markers.set(anchorId, {
      kind: lastKey === null ? 'served' : 'switched',
      stamp,
    })
    lastKey = key
  }

  return markers
}
