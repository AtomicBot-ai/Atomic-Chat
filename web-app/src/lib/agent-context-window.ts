/**
 * Connect's minimum context window (X1, audit 2026-11-03). A coding agent's
 * system prompt and tool definitions alone fill most of the desktop's
 * default 16K window: the first turn overflows and the agent stops, or never
 * compacts. Before an agent is pointed at the served model, a model loaded
 * with less than the agent's `minContextLength` is reloaded with at least
 * that — the ladder the chat grows its context by (`growModelContext`). When
 * that cannot work (the engine sizes the window itself, the model is trained
 * shorter, the bigger load does not fit in memory) nothing is written and the
 * caller says why. A window the engine cannot report is left alone.
 */

import type { IntegrationAgent } from '@/constants/integrations'
import { useModelProvider } from '@/hooks/useModelProvider'
import { getServiceHub } from '@/hooks/useServiceHub'
import {
  getModelMaxCtxTrain,
  growModelContext,
  setModelContextLength,
} from '@/lib/context-size'
import { readProviderFit } from '@/lib/provider-fit'
import {
  loadServedModel,
  servedContextLength,
  servedModel,
  type ServedModel,
} from '@/utils/servedModel'

type Translate = (key: string, options?: Record<string, unknown>) => string

export type AgentContextWindow =
  | {
      ok: true
      /** The served window, for the agent's config; unknown is `undefined`. */
      contextLength: number | undefined
    }
  | {
      ok: false
      minimum: number
      /** The window the model has (or, for `model_max`, can have). */
      contextLength: number
      /**
       * `fit` — "Fit to device memory" sizes the window; `model_max` — the
       * model is trained shorter; `reload` — it did not load with more.
       */
      reason: 'fit' | 'model_max' | 'reload'
    }

/** {@link servedModel}; like `servedContextLength`, a store that cannot say is none. */
function currentServedModel(): ServedModel | null {
  try {
    return servedModel()
  } catch {
    return null
  }
}

/**
 * Make sure `model` (by default the one the server serves) runs with at least
 * `agent.minContextLength`, reloading it with more when it does not.
 */
export async function ensureAgentContextWindow(
  agent: IntegrationAgent,
  model?: ServedModel | null
): Promise<AgentContextWindow> {
  const minimum = agent.minContextLength
  const served = model === undefined ? currentServedModel() : model
  const current = await servedContextLength(served)
  if (!served || !minimum || current === undefined || current >= minimum)
    return { ok: true, contextLength: current }

  const fail = (
    reason: 'fit' | 'model_max' | 'reload',
    contextLength = current
  ): AgentContextWindow => ({ ok: false, minimum, contextLength, reason })

  const provider = useModelProvider
    .getState()
    .getProviderByName(served.provider)
  if (readProviderFit(provider) === true) return fail('fit')
  const trained = await getModelMaxCtxTrain(served.provider, served.model)
  if (trained !== undefined && trained < minimum)
    return fail('model_max', trained)

  const serviceHub = getServiceHub()
  const grown = await growModelContext({
    providerId: served.provider,
    modelId: served.model,
    serviceHub,
    minCtxLen: minimum,
  })
  if (!grown.ok) {
    if (grown.reason === 'fit') return fail('fit')
    if (grown.reason === 'at_max')
      return fail('model_max', grown.max ?? current)
    return fail('reload')
  }

  try {
    const loaded = await loadServedModel(serviceHub.models(), served)
    if (loaded.status === 'no_model_available')
      throw new Error('No model available to load')
  } catch (error) {
    // Most likely memory. Put the window it had back, so the server keeps
    // serving the model it did.
    console.warn(
      `[LocalAPI] ${served.model} did not load with a ${grown.to}-token window:`,
      error
    )
    setModelContextLength(served.provider, served.model, grown.from)
    await loadServedModel(serviceHub.models(), served).catch((reload) =>
      console.warn(`[LocalAPI] could not reload ${served.model}:`, reload)
    )
    return fail('reload')
  }

  const after = await servedContextLength(served)
  // The engine clamped it (a trained maximum it did not report up front).
  if (after !== undefined && after < minimum) return fail('model_max', after)
  return { ok: true, contextLength: after }
}

/** "32K" for whole multiples of 1024, the number otherwise. */
export function formatContextTokens(tokens: number): string {
  return tokens % 1024 === 0 ? `${tokens / 1024}K` : String(tokens)
}

/** The toast (or guide error) for a window `agent` cannot work in. */
export function contextWindowMessage(
  t: Translate,
  agent: IntegrationAgent,
  failure: Extract<AgentContextWindow, { ok: false }>
): { title: string; description: string } {
  const current = formatContextTokens(failure.contextLength)
  return {
    title: t('launch:toast.contextTooSmall', {
      name: agent.name,
      minimum: formatContextTokens(failure.minimum),
    }),
    description:
      failure.reason === 'fit'
        ? t('launch:toast.contextTooSmallFit', { current })
        : failure.reason === 'model_max'
          ? t('launch:toast.contextTooSmallModel', { current })
          : t('launch:toast.contextTooSmallMemory', { current }),
  }
}

/** Thrown when Connect stops for the context window; says why in full. */
export class AgentContextError extends Error {
  readonly title: string
  readonly description: string

  constructor({ title, description }: { title: string; description: string }) {
    super(`${title}. ${description}`)
    this.name = 'AgentContextError'
    this.title = title
    this.description = description
  }
}

/**
 * The served window to write into `agent`'s config, after
 * {@link ensureAgentContextWindow}; throws {@link AgentContextError} when
 * the agent cannot work in it.
 */
export async function requireAgentContextWindow(
  agent: IntegrationAgent,
  t: Translate,
  served?: ServedModel | null
): Promise<number | undefined> {
  const window = await ensureAgentContextWindow(agent, served)
  if (window.ok) return window.contextLength
  throw new AgentContextError(contextWindowMessage(t, agent, window))
}
