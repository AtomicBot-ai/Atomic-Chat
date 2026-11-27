import { useDsparkSelection } from '@/services/drafters'
import { useModelProvider } from '@/hooks/useModelProvider'
import { withRecommendedSampling } from '@/lib/predefinedParams'
import type { ResolvedSamplingParams } from '@/lib/samplingParams'

export function shouldSuppressToolsForUpstreamDflash(
  providerId: string,
  settings: readonly ProviderSetting[] | undefined,
  modelId = useModelProvider.getState().selectedModel?.id
): boolean {
  return (
    !(modelId && useDsparkSelection.getState().ids[modelId]) &&
    providerId === 'llamacpp-upstream' &&
    settings?.some(
      (setting) =>
        setting.key === 'dflash' && setting.controller_props.value === true
    ) === true
  )
}

export function withUpstreamDflashSampling(
  providerId: string,
  settings: readonly ProviderSetting[] | undefined,
  params: Record<string, unknown>,
  modelId?: string
): Record<string, unknown> {
  if (!shouldSuppressToolsForUpstreamDflash(providerId, settings, modelId))
    return params
  return {
    ...params,
    temperature: 0,
    top_k: 1,
    repeat_penalty: 1,
    presence_penalty: 0,
    frequency_penalty: 0,
  }
}

/** Apply the actual served model's family and engine policies for both chat and pi. */
export function modelSamplingParams(
  providerId: string,
  modelId: string,
  settings: readonly ProviderSetting[] | undefined,
  sampling: ResolvedSamplingParams
) {
  return withUpstreamDflashSampling(
    providerId,
    settings,
    withRecommendedSampling(modelId, sampling.params, sampling.overridden),
    modelId
  )
}
