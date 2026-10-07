/**
 * The managed engines the app knows (openspec change `add-vllm-runtime`, design D14): engines the
 * core runs in a container — on Linux in Docker, on Windows in Atomic Chat's own WSL distribution —
 * set up through the core's environment operations and fed from one shared model store.
 *
 * The engine id is the core's `engine_id` and the provider id at once (core design D3), so every
 * screen that knew `'tensorrt-llm'` by name asks this registry instead. The order is the priority:
 * every list that shows more than one managed engine — providers, the Model Hub's formats, a model
 * card's verdicts, the engine offered for a new chat — shows them in this order.
 */

export interface ManagedEngine {
  /** The core's `engine_id` and the provider id. */
  id: string
  /** The engine's name in every sentence that names it. */
  label: string
  /**
   * The key of the engine's own block in `providers.json` and `hub.json`: every text of the shared
   * screens is read from it, so an engine's wording never leaks into another's.
   */
  i18n: string
}

export const TENSORRT_LLM_ENGINE: ManagedEngine = {
  id: 'tensorrt-llm',
  label: 'TensorRT-LLM',
  i18n: 'tensorrt',
}

export const VLLM_ENGINE: ManagedEngine = {
  id: 'vllm',
  label: 'vLLM',
  i18n: 'vllm',
}

/** vLLM first (spec `vllm-desktop`: "В списках провайдеров vLLM MUST стоять раньше TensorRT-LLM"). */
const DEFAULT_ENGINES: readonly ManagedEngine[] = [VLLM_ENGINE, TENSORRT_LLM_ENGINE]

let engines: readonly ManagedEngine[] = DEFAULT_ENGINES

/** Every managed engine, in priority order. */
export function managedEngines(): readonly ManagedEngine[] {
  return engines
}

/** The managed engine whose provider id this is, or `undefined` for any other provider. */
export function managedEngine(providerId: string | undefined): ManagedEngine | undefined {
  return providerId === undefined ? undefined : engines.find((engine) => engine.id === providerId)
}

/** Whether the provider is a managed engine: its models live in the shared store, its sessions in a container. */
export function isManagedProvider(providerId: string | undefined): boolean {
  return managedEngine(providerId) !== undefined
}

/**
 * The managed engine `providerId` names; throws for any other id. For code that is only ever
 * reached for a managed provider, where an unknown id is a bug rather than a case to handle.
 */
export function requireManagedEngine(providerId: string): ManagedEngine {
  const engine = managedEngine(providerId)
  if (!engine) throw new Error(`Not a managed engine: ${providerId}`)
  return engine
}

/** Tests that need a second engine register one; `undefined` restores the app's own list. */
export function setManagedEnginesForTests(list: readonly ManagedEngine[] | undefined): void {
  engines = list ?? DEFAULT_ENGINES
}

/** The full key of `key` in the engine's own block of `providers.json`. */
export function providerKey(engine: ManagedEngine): (key: string) => string {
  return (key) => `providers:${engine.i18n}.${key}`
}

/** The full key of `key` in the engine's own block of `hub.json`. */
export function hubKey(engine: ManagedEngine): (key: string) => string {
  return (key) => `hub:${engine.i18n}.${key}`
}
