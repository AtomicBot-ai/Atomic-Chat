import { useMemo } from 'react'

import {
  audioGenerateDisabledReason,
  audioTargetOf,
  audioWireId,
  isAudioQuantOnDisk,
  type AudioGenerateDisabledReason,
  type AudioSettings,
} from '@/lib/audio/models'
import type {
  AudioCatalogModel,
  AudioCatalogQuant,
} from '@/services/audio-catalog-registry'
import type { AudioCapabilities, AudioMode } from '@/services/audio/types'
import { useAudioGenerationStore } from '@/stores/audio-generation-store'

export type AudioGenerationHandle = {
  mode: AudioMode
  form: AudioSettings
  model: AudioCatalogModel | null
  quant: AudioCatalogQuant | null
  /** The form's model is on disk. */
  modelReady: boolean
  /** What the model takes, once it is the loaded one. */
  capabilities: AudioCapabilities | null
  disabledReason: AudioGenerateDisabledReason | null
}

/**
 * The form's model and why Generate is off, derived from the store so the form
 * and the results pane can never disagree. A model that is on disk but stopped
 * does not block Generate: Generate starts it.
 */
export function useAudioGeneration(): AudioGenerationHandle {
  const mode = useAudioGenerationStore((state) => state.mode)
  const form = useAudioGenerationStore((state) => state.forms[state.mode])
  const catalog = useAudioGenerationStore((state) => state.catalog)
  const core = useAudioGenerationStore((state) => state.core)
  const status = useAudioGenerationStore((state) => state.status)
  const modelFiles = useAudioGenerationStore((state) => state.modelFiles)
  const loaded = useAudioGenerationStore((state) => state.capabilities)
  const loadingModelId = useAudioGenerationStore(
    (state) => state.loadingModelId
  )

  const target = useMemo(() => audioTargetOf(catalog, form), [catalog, form])
  const wireId = target ? audioWireId(target.model, target.quant) : null
  const modelReady = target
    ? isAudioQuantOnDisk(target.quant, modelFiles)
    : false
  const capabilities = loaded && loaded.modelId === wireId ? loaded : null

  return {
    mode,
    form,
    model: target?.model ?? null,
    quant: target?.quant ?? null,
    modelReady,
    capabilities,
    disabledReason: audioGenerateDisabledReason(form, {
      core,
      engineInstalled: status?.install.state === 'installed',
      modelReady,
      modelLoading: loadingModelId !== null,
      capabilities,
    }),
  }
}
