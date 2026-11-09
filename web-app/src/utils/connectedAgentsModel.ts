/**
 * Connect writes the id of the model the server serves into the agent's own
 * config (`writeAgentConfig`), and the server serves one chat model at a
 * time, the one the chat uses too: a chat switched to another model replaced
 * it, and every connected agent still asking for the old id got 404 (B02, QA
 * 2.3.2). The configs follow the served model instead: each change of it is
 * written into every agent Atomic Chat connected, so the agent's next launch
 * asks for the model actually served. An agent Atomic Chat opened is asked
 * about and restarted by the switch itself (`agentSwitchGuard.ts`); the
 * change is written without a toast (ADR 2026-11-09).
 * ADR 2026-11-03-keep-connected-agents-on-the-model-the-server-serves.
 */

import {
  INTEGRATION_AGENTS,
  type IntegrationAgent,
} from '@/constants/integrations'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServerSetup } from '@/hooks/useServerSetup'
import { isEmbeddingOnlyModel } from '@/lib/answerable-model'
import { writeAgentConfig } from '@/lib/integration-agent-setup'
import { isLocalProvider } from '@/utils/registerRemoteProvider'
import {
  servedContextLength,
  servedModel,
  servedModelId,
} from '@/utils/servedModel'

/** The connected agents whose config Atomic Chat writes, in connection order. */
export function connectedConfigurableAgents(): IntegrationAgent[] {
  return useServerSetup.getState().configuredAgents.flatMap(({ id }) => {
    const agent = INTEGRATION_AGENTS.find((candidate) => candidate.id === id)
    return agent?.configurable ? [agent] : []
  })
}

/**
 * Write `model` into every connected agent's config, with the server's
 * current address and key. Never throws: an agent whose config cannot be
 * written keeps the one it has, and the failure is logged. Resolves the
 * agents written.
 */
export async function pointConnectedAgentsAt(
  model: string
): Promise<IntegrationAgent[]> {
  const server = useLocalApiServer.getState()
  const served = servedModel()
  const contextLength =
    served?.model === model ? await servedContextLength(served) : undefined
  const written: IntegrationAgent[] = []
  for (const agent of connectedConfigurableAgents()) {
    try {
      await writeAgentConfig(agent, model, server, { contextLength })
      written.push(agent)
    } catch (error) {
      console.warn(
        `[LocalAPI] could not point ${agent.name} at ${model}:`,
        error
      )
    }
  }
  return written
}

/** The model as a provider lists it, when one does and it can chat. */
function findChatModel(modelId: string): Model | undefined {
  for (const provider of useModelProvider.getState().providers) {
    const model = provider?.models?.find((m) => m.id === modelId)
    if (model) return isEmbeddingOnlyModel(model) ? undefined : model
  }
  return undefined
}

/**
 * Keep the connected agents on the model the server serves: whenever it
 * changes to another local chat model a provider lists, point them at it.
 * The model served at subscription is taken as the one they use.
 * Writes run one after another; one overtaken by a newer change is dropped.
 * Returns the unsubscribe.
 */
export function syncConnectedAgentsWithServedModel(): () => void {
  // The model the agents were last pointed at.
  let current = servedModelId()
  // The newest model they should use.
  let wanted = current
  let queue: Promise<void> = Promise.resolve()

  const point = async (model: string) => {
    if (model !== wanted || model === current) return
    await pointConnectedAgentsAt(model)
    current = model
  }

  return useLocalApiServer.subscribe((state) => {
    const served = servedModel(state)
    const model = served?.model
    // Only a local model: a chat switched to a cloud model must not send the
    // agents' traffic to that paid provider unasked.
    if (!model || !isLocalProvider(served.provider)) return
    if (model === wanted || !findChatModel(model)) return
    wanted = model
    queue = queue
      .then(() => point(model))
      .catch((error) =>
        console.warn('[LocalAPI] could not update the connected agents:', error)
      )
  })
}
