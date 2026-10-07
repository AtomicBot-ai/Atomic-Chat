/** A container-backed load's stages on `atomic-core://session:load-progress` (design D8). */
export const CORE_SESSION_LOAD_STAGES = [
  'stopping-previous',
  'starting-container',
  'initializing-engine',
  'ready',
] as const
export type CoreSessionLoadStage = (typeof CORE_SESSION_LOAD_STAGES)[number]

/** A stage a newer core may add is shown as the engine preparing, never as a raw key. */
export function knownLoadStage(stage: string): CoreSessionLoadStage {
  return (CORE_SESSION_LOAD_STAGES as readonly string[]).includes(stage)
    ? (stage as CoreSessionLoadStage)
    : 'initializing-engine'
}
