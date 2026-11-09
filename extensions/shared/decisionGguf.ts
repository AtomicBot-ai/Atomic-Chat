/**
 * Whether GGUF metadata describes a decision model (a router or classifier
 * that answers probabilities, not text). Mirrors `isDecisionGguf` in
 * atomic-chat-core (`src/models/gguf/classify.ts`), which refuses to load such
 * a file for chat: it runs only in the decision module, behind `/v1/systemone`.
 *
 * Three shapes: the fork's `laya` architecture, any architecture stamped with
 * `decision.layout` (an Arbiter GGUF stays `qwen35` underneath), and an
 * upstream llama.cpp decision GGUF, which carries `<arch>.decision.type`
 * (Julia, Kev, Clef, and third-party ones such as d1-3B-Artemis).
 */
export function isDecisionGguf(
  metadata: Record<string, unknown> | undefined | null
): boolean {
  if (!metadata) return false
  const raw = metadata['general.architecture']
  const arch = typeof raw === 'string' ? raw.trim() : ''
  if (arch.toLowerCase() === 'laya') return true
  if (arch !== '') {
    const type = metadata[`${arch}.decision.type`]
    if (typeof type === 'string' && type.trim() !== '') return true
  }
  const layout = metadata['decision.layout']
  return typeof layout === 'string'
    ? layout.trim() !== ''
    : layout !== undefined && layout !== null
}
