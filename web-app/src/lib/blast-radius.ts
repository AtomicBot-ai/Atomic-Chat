/**
 * What a system-changing agent action will do, as the backend describes it
 * in an approval preview (`preview.blastRadius`, see `net::BlastRadius`).
 */
export type BlastRadius = {
  action: string
  changes: string
  disruption: string
  affects: string
  undo: string
  needsAdmin: boolean
  needsReboot: boolean
  risk: 'low' | 'medium' | 'high'
}

const RISKS = new Set(['low', 'medium', 'high'])

/** The blast radius in an approval preview, or `null` when there is none. */
export function readBlastRadius(preview: unknown): BlastRadius | null {
  if (!preview || typeof preview !== 'object') return null
  const radius = (preview as Record<string, unknown>).blastRadius
  if (!radius || typeof radius !== 'object') return null
  const value = radius as Record<string, unknown>
  const text = (key: string) =>
    typeof value[key] === 'string' ? (value[key] as string) : ''
  if (!text('action') || !RISKS.has(text('risk'))) return null
  return {
    action: text('action'),
    changes: text('changes'),
    disruption: text('disruption'),
    affects: text('affects'),
    undo: text('undo'),
    needsAdmin: value.needsAdmin === true,
    needsReboot: value.needsReboot === true,
    risk: text('risk') as BlastRadius['risk'],
  }
}

/** A second opinion on the change from a separate reviewer call. */
export type ChangeReview = {
  verdict: 'agree' | 'concern' | 'disagree' | 'unavailable'
  reason: string
}

const VERDICTS = new Set(['agree', 'concern', 'disagree', 'unavailable'])

/** The reviewer's verdict in an approval preview, or `null` when there is none. */
export function readChangeReview(preview: unknown): ChangeReview | null {
  if (!preview || typeof preview !== 'object') return null
  const review = (preview as Record<string, unknown>).review
  if (!review || typeof review !== 'object') return null
  const { verdict, reason } = review as Record<string, unknown>
  if (typeof verdict !== 'string' || !VERDICTS.has(verdict)) return null
  return {
    verdict: verdict as ChangeReview['verdict'],
    reason: typeof reason === 'string' ? reason : '',
  }
}

/** Why the agent says it wants the change, when it said. */
export function readAgentReason(preview: unknown): string | null {
  if (!preview || typeof preview !== 'object') return null
  const reason = (preview as Record<string, unknown>).agentReason
  return typeof reason === 'string' && reason.trim() ? reason.trim() : null
}
