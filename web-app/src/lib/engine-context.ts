import { isManagedProvider } from '@/lib/managed-engines'

/** Context settings consumed by the engine at load time, shared by its models. */
export function engineContext(
  provider?: ModelProvider,
  model?: Model | null,
  strataMax?: number
) {
  if (!provider || !model) return
  const id = provider.provider
  const managed = isManagedProvider(id)
  const key = managed || id === 'strata' ? 'context_length' : 'ctx_len'
  if (!managed && !['strata', 'fastflowlm', 'geniex', 'litert-lm'].includes(id))
    return
  const setting = provider.settings.find((item) => item.key === key)
  if (!setting) return

  const props = setting.controller_props as ControllerProps & {
    min?: number
    max?: number
  }
  const configured = Number(props.value)
  const modelLimit =
    id === 'strata'
      ? (strataMax ?? model.strata?.context_length)
      : model.contextLength
  if (id === 'strata' && !modelLimit) return
  const read = (key: string) =>
    Number(
      provider.settings.find((item) => item.key === key)?.controller_props.value
    ) || 0
  const cacheLimit = id === 'sglang' ? read('max_total_tokens') : 0
  const min = managed ? Math.max(512, read('max_output_tokens') + 1) : 1
  let max = Math.min(
    Number(props.max),
    modelLimit || Infinity,
    cacheLimit || Infinity
  )
  if (!Number.isSafeInteger(max) || max <= 0) return
  if (id === 'fastflowlm') max = 2 ** Math.floor(Math.log2(max))

  const auto = Number(props.min) === 0 && (!managed || min <= 65536)
  const powers = id === 'fastflowlm'
  // FastFlowLM accepts powers of two starting at 512. Other engines use 1 Ki-token steps.
  const first = powers ? Math.log2(512) : Math.max(1, Math.ceil(min / 1024))
  const last = powers ? Math.floor(Math.log2(max)) : Math.floor(max / 1024)
  const regular = Math.max(0, last - first + 1)
  const extra = !powers && max % 1024 !== 0 && max >= min
  const count = Number(auto) + regular + Number(extra)
  if (!count) return
  const at = (index: number) => {
    if (auto && index === 0) return 0
    const slot = index - Number(auto)
    if (slot >= regular) return max
    return powers ? 2 ** (first + slot) : (first + slot) * 1024
  }
  const indexOf = (tokens: number) => {
    if (auto && tokens === 0) return 0
    if (tokens >= max) return count - 1
    const slot =
      Math.round(powers ? Math.log2(Math.max(512, tokens)) : tokens / 1024) -
      first
    return Number(auto) + Math.max(0, Math.min(regular - 1, slot))
  }
  let capacity =
    configured || (id === 'strata' ? model.strata?.context_length : modelLimit)
  // The compact Strata CUDA profile and managed engines choose Auto at load.
  if (!configured && (managed || model.strata?.family === 'qwen36'))
    capacity = undefined
  if (capacity && id === 'fastflowlm') {
    capacity = Math.min(max, 2 ** Math.ceil(Math.log2(Math.max(512, capacity))))
  }
  if (id === 'strata' && configured > max) capacity = undefined
  if (capacity && modelLimit) capacity = Math.min(capacity, modelLimit)
  const missingModelLimit = managed && !modelLimit
  const exceedsLimit = managed && configured > max
  if (missingModelLimit || exceedsLimit) capacity = undefined
  return { setting, configured, count, at, indexOf, capacity, missingModelLimit, exceedsLimit }
}
