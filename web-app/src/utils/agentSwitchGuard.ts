/**
 * A model switch that would cut off agents Atomic Chat opened asks first.
 *
 * Connected agents are pointed at the model the server serves
 * (`connectedAgentsModel.ts`), but an agent already running keeps the model
 * it read when it started. A switch left it asking for a model no longer
 * loaded (404), or for nothing at all after a switch to a cloud model, which
 * unloads every local one. Every switch — the model dropdown, a send, a
 * thread's own model, Start on an engine page, an auto-start — runs through
 * `switchToModel`, and that asks here before it touches anything.
 *
 * When an agent Atomic Chat opened in a terminal still runs on another model
 * (`list_agent_terminals`), the user is asked. Yes: the agents are stopped
 * before the switch and opened again once the new model is served, the way
 * Connect opens them, a cloud model included — the user chose it for them.
 * No: nothing changes, and the selection goes back to the model the server
 * serves. Their conversations start over either way they are restarted.
 * ADR 2026-11-09-ask-before-a-model-switch-restarts-running-agents.
 */

import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { create } from 'zustand'

import {
  INTEGRATION_AGENTS,
  type IntegrationAgent,
} from '@/constants/integrations'
import { useModelProvider } from '@/hooks/useModelProvider'
import i18n from '@/i18n/setup'
import { compactModelDisplayName } from '@/lib/model-display-name'
import { getProviderTitle } from '@/lib/utils'
import { isLocalProvider } from '@/utils/registerRemoteProvider'

/** An agent `open_agent_terminal` opened that still runs (Rust `AgentSessionInfo`). */
export type AgentTerminal = { agentId: string; model: string | null }

/** The switch asked about. */
export type AgentSwitchTarget = { modelId: string; providerName: string }

/** What the dialog shows. */
export type AgentSwitchQuestion = {
  agents: IntegrationAgent[]
  /** The target model's display name. */
  model: string
  /** The cloud provider's title when the target is a cloud model. */
  cloudProvider: string | null
}

/** What a switch does about the agents. */
export type AgentSwitchDecision =
  | { kind: 'proceed' }
  | { kind: 'declined' }
  | { kind: 'restart'; agents: IntegrationAgent[] }

type PendingQuestion = AgentSwitchQuestion & {
  key: string
  answer: Promise<boolean>
  resolve: (confirmed: boolean) => void
  /** The first switch to receive the yes restarts the agents; any other joined. */
  claimed: boolean
}

type AgentSwitchState = { pending: PendingQuestion | null }

/** The question on screen (`AgentSwitchDialog`), if any. */
export const useAgentSwitchQuestion = create<AgentSwitchState>(() => ({
  pending: null,
}))

/** The toast id `connectedAgentsModel.ts` uses, so one replaces the other. */
export const AGENTS_MODEL_TOAST_ID = 'connected-agents-model'

/** The agents Atomic Chat opened that still run. Never throws. */
export async function listAgentTerminals(): Promise<AgentTerminal[]> {
  try {
    const found = await invoke<AgentTerminal[] | undefined>(
      'list_agent_terminals'
    )
    return Array.isArray(found) ? found : []
  } catch {
    return []
  }
}

/** Stop the agent Atomic Chat opened as `agentId`. Never throws. */
export async function stopAgentTerminal(agentId: string): Promise<boolean> {
  try {
    return (await invoke<boolean>('stop_agent_terminal', { agentId })) === true
  } catch (error) {
    console.warn(`[agentSwitch] could not stop ${agentId}:`, error)
    return false
  }
}

function targetKey({ providerName, modelId }: AgentSwitchTarget): string {
  return `${providerName}::${modelId}`
}

function questionFor(
  target: AgentSwitchTarget,
  agents: IntegrationAgent[]
): AgentSwitchQuestion {
  const provider = useModelProvider
    .getState()
    .providers.find((p) => p?.provider === target.providerName)
  const listed = provider?.models?.find((m) => m.id === target.modelId)
  return {
    agents,
    model: compactModelDisplayName(listed ?? { id: target.modelId }),
    cloudProvider: isLocalProvider(target.providerName)
      ? null
      : getProviderTitle(target.providerName),
  }
}

/**
 * Show the question for `target`, or join the one already shown for it. A
 * question for another target is answered no first: only the newest switch
 * is the user's intent.
 */
function ask(
  target: AgentSwitchTarget,
  agents: IntegrationAgent[]
): { answer: Promise<boolean>; first: () => boolean } {
  const key = targetKey(target)
  const open = useAgentSwitchQuestion.getState().pending
  if (open && open.key === key) {
    return { answer: open.answer, first: () => claim(open) }
  }
  if (open) answerAgentSwitch(false)
  let resolve!: (confirmed: boolean) => void
  const answer = new Promise<boolean>((done) => {
    resolve = done
  })
  const pending: PendingQuestion = {
    ...questionFor(target, agents),
    key,
    answer,
    resolve,
    claimed: false,
  }
  useAgentSwitchQuestion.setState({ pending })
  return { answer, first: () => claim(pending) }
}

function claim(pending: PendingQuestion): boolean {
  if (pending.claimed) return false
  pending.claimed = true
  return true
}

/** The dialog's answer. */
export function answerAgentSwitch(confirmed: boolean): void {
  const pending = useAgentSwitchQuestion.getState().pending
  if (!pending) return
  useAgentSwitchQuestion.setState({ pending: null })
  pending.resolve(confirmed)
}

/**
 * Whether switching to `target` cuts off agents Atomic Chat opened, and what
 * the user wants done about it. Agents opened for the target model already
 * are left alone, and so is everything when none runs (or the app cannot
 * tell, in a browser).
 */
export async function decideAgentsBeforeSwitch(
  target: AgentSwitchTarget
): Promise<AgentSwitchDecision> {
  const running = await listAgentTerminals()
  const agents = running.flatMap(({ agentId, model }) => {
    if (model === target.modelId) return []
    const agent = INTEGRATION_AGENTS.find((a) => a.id === agentId)
    return agent ? [agent] : []
  })
  if (agents.length === 0) return { kind: 'proceed' }
  const { answer, first } = ask(target, agents)
  if (!(await answer)) return { kind: 'declined' }
  return first() ? { kind: 'restart', agents } : { kind: 'proceed' }
}

/** Stop `agents` before the switch takes their model away. */
export async function stopAgentsForSwitch(
  agents: IntegrationAgent[]
): Promise<void> {
  for (const agent of agents) await stopAgentTerminal(agent.id)
}

/**
 * Opens an agent again the way Connect does: its config pointed at the
 * model the server serves, then its terminal. Registered by the dialog,
 * which has the Connect action.
 */
type ReopenAgent = (agent: IntegrationAgent) => Promise<void>
let reopenAgent: ReopenAgent | null = null

export function registerAgentReopen(reopen: ReopenAgent): () => void {
  reopenAgent = reopen
  return () => {
    if (reopenAgent === reopen) reopenAgent = null
  }
}

/**
 * The model `connectedAgentsModel.ts` should not announce: the agents
 * restarted for it are announced here instead, and its "restart a running
 * tool" would be wrong.
 */
let quietModel: string | null = null

/** Mark `model`'s switch as announced by the restart; `null` takes it back. */
export function quietAgentsToastFor(model: string | null): void {
  quietModel = model
}

/** Whether the toast for `model` was taken over by a restart (once). */
export function consumeQuietAgentsToast(model: string): boolean {
  if (quietModel !== model) return false
  quietModel = null
  return true
}

function names(agents: IntegrationAgent[]): string {
  return agents.map((agent) => agent.name).join(', ')
}

/** Open `agents` again on `served`, the model now served, and say so once. */
export async function reopenAgentsAfterSwitch(
  agents: IntegrationAgent[],
  served: AgentSwitchTarget
): Promise<void> {
  if (!reopenAgent) return
  const { model } = questionFor(served, agents)
  for (const agent of agents) {
    try {
      await reopenAgent(agent)
    } catch (error) {
      console.warn(`[agentSwitch] could not reopen ${agent.name}:`, error)
    }
  }
  toast.success(
    i18n.t('api:agentSwitch.restarted', { names: names(agents), model }),
    {
      id: AGENTS_MODEL_TOAST_ID,
      description: i18n.t('api:agentSwitch.restartedDesc'),
    }
  )
}

/** The switch failed or was cancelled after `agents` were stopped. */
export function reportAgentsStopped(agents: IntegrationAgent[]): void {
  toast.warning(i18n.t('api:agentSwitch.stopped'), {
    id: AGENTS_MODEL_TOAST_ID,
    description: i18n.t('api:agentSwitch.stoppedDesc', {
      names: names(agents),
    }),
    duration: 10000,
  })
}
