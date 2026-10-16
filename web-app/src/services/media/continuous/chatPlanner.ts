/**
 * Binds the planner to the chat model the user has selected, through the same
 * ModelFactory the chat uses (so llama.cpp sessions are discovered/started the
 * normal way). Kept apart from `planner.ts` so that stays pure.
 */
import type { PlannerDeps } from './planner'

export async function defaultPlannerDeps(): Promise<PlannerDeps> {
  const [{ useModelProvider }, { ModelFactory }, { generateText }] = await Promise.all([
    import('@/hooks/useModelProvider'),
    import('@/lib/model-factory'),
    import('ai'),
  ])
  const state = useModelProvider.getState()
  const model = state.selectedModel
  const provider = state.getProviderByName(state.selectedProvider)
  const warn = (message: string, cause?: unknown) => console.warn(`[timeline-planner] ${message}`, cause)
  if (!model || !provider) return { warn }
  return {
    warn,
    complete: async ({ system, prompt }) => {
      const languageModel = await ModelFactory.createModel(model.id, provider, {})
      const result = await generateText({ model: languageModel, system, prompt, temperature: 0.4 })
      return result.text
    },
  }
}
