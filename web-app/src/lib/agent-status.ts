/**
 * One state per integration agent, in the order the user gets there:
 * Not installed → Installed → Configured → Opened → Connected.
 *
 * - Configured: its config points at this server (written here, or found
 *   pointing here). For an agent that runs on this computer it also needs to
 *   be installed: a config with no program to read it is not ready. ZCode,
 *   which is never installed from here, is "App not installed" then, with
 *   its download in place of Connect.
 * - Opened: Atomic Chat opened it (a terminal, or its app) while this server
 *   ran. Launch history only: nothing says the window is still there.
 * - Connected: since it was opened, the server saw a request that came from
 *   it.
 *
 * Which request came from which agent: the request log carries no client
 * name (no User-Agent), so a request is credited by what the agent sends.
 * Claude Code alone speaks Anthropic's `/v1/messages`; Codex and Muse speak
 * `/v1/responses`; the others `/v1/chat/completions`. Each agent asks for the
 * model its config was written with (Claude Code may also ask for its own
 * side models, so its model is not compared). A request is credited to the
 * agent that matches it and was opened most recently before it — two agents
 * opened back to back on the same endpoint and model cannot be told apart,
 * and the later one is credited. A request the server refused as malformed
 * (a 4xx: wrong key, unknown model) does not count: the agent reached the
 * server but does not work with it.
 */

import type { IntegrationAgent } from '@/constants/integrations'
import type { ApiLogEntry, ApiRequestEntry } from '@/types/apiServerLog'

export type AgentState =
  | 'not_installed'
  | 'installed'
  | 'app_missing'
  | 'configured'
  | 'opened'
  | 'connected'

/** When Atomic Chat opened an agent, and the model its config named. */
export type OpenedAgent = { at: number; model: string | null }

type RequestSignature = {
  /** Inspector endpoint labels (`endpointFromPath` in the core). */
  endpoints: readonly string[]
  /** Whether the request names the model the agent was opened with. */
  matchModel: boolean
}

const CHAT_COMPLETIONS: RequestSignature = {
  endpoints: ['chat/completions', 'completions'],
  matchModel: true,
}

const SIGNATURES: Record<string, RequestSignature> = {
  'claude-code': {
    endpoints: ['messages', 'messages/count_tokens'],
    matchModel: false,
  },
  'codex': { endpoints: ['responses'], matchModel: true },
  'muse': { endpoints: ['responses'], matchModel: true },
}

/** What a request from `agentId` looks like in the log. */
export function requestSignature(agentId: string): RequestSignature {
  return SIGNATURES[agentId] ?? CHAT_COMPLETIONS
}

function matches(
  agentId: string,
  opened: OpenedAgent,
  request: ApiRequestEntry
): boolean {
  if (opened.at > request.startedAt) return false
  const signature = requestSignature(agentId)
  if (!signature.endpoints.includes(request.endpoint)) return false
  if (signature.matchModel && opened.model && request.model !== opened.model)
    return false
  const refused =
    request.status === 'error' &&
    typeof request.httpStatus === 'number' &&
    request.httpStatus >= 400 &&
    request.httpStatus < 500
  return !refused
}

/**
 * The opened agents the log shows a request from: each request goes to the
 * matching agent opened most recently before it.
 */
export function agentsWithRequests(
  opened: Record<string, OpenedAgent>,
  entries: readonly ApiLogEntry[]
): Set<string> {
  const credited = new Set<string>()
  const candidates = Object.entries(opened)
  if (candidates.length === 0) return credited
  for (const entry of entries) {
    if (entry.kind !== 'request') continue
    let best: [string, OpenedAgent] | null = null
    for (const candidate of candidates) {
      if (!matches(candidate[0], candidate[1], entry)) continue
      if (!best || candidate[1].at > best[1].at) best = candidate
    }
    if (best) credited.add(best[0])
  }
  return credited
}

export type AgentFacts = {
  /** Detection's answer; `undefined` until it has run. */
  installed: boolean | undefined
  configured: boolean
  opened: boolean
  connected: boolean
}

/** Where `agent` stands, from what the app knows about it. */
export function deriveAgentState(
  agent: Pick<IntegrationAgent, 'kind' | 'installable'>,
  facts: AgentFacts
): AgentState {
  if (!facts.configured) return facts.installed ? 'installed' : 'not_installed'
  // An editor set up by hand has nothing Atomic Chat opens or detects.
  if (agent.kind === 'editor') return 'configured'
  if (facts.installed === false)
    return agent.installable ? 'not_installed' : 'app_missing'
  if (!facts.opened) return 'configured'
  return facts.connected ? 'connected' : 'opened'
}

/** States in which the agent is set up and can be opened. */
export function isSetUp(state: AgentState): boolean {
  return state === 'configured' || state === 'opened' || state === 'connected'
}
