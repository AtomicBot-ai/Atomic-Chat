import { memo, useCallback, useEffect, useState } from 'react'

import { ImageEmptyState } from '@/containers/images/ImageEmptyState'
import { MediaStudioFrame } from '@/containers/images/MediaStudio'
import { useAudioGeneration } from '@/hooks/useAudioGeneration'
import type { AudioErrorAction } from '@/lib/audio/errors'
import { useAudioGenerationStore } from '@/stores/audio-generation-store'

import { AudioErrorBanner } from './AudioErrorBanner'
import { AudioPromptForm } from './AudioPromptForm'
import { AudioResultsPane } from './AudioResultsPane'
import './audios.css'

/**
 * Audios: speech, music and sound effects in the studio Images and Video use —
 * the form column on the left, the results pane on the right. Models come from
 * the audio catalog, run on the core's audio.cpp engine and leave their clips
 * in the core's gallery. A core without audio shows the page with a notice and
 * nothing that can start.
 */
export const AudioGenerationPage = memo(function AudioGenerationPage() {
  const [modelsOpen, setModelsOpen] = useState(false)
  const { modelReady } = useAudioGeneration()
  const core = useAudioGenerationStore((state) => state.core)
  const lastError = useAudioGenerationStore((state) => state.lastError)
  const clearError = useAudioGenerationStore((state) => state.clearError)
  const hasContent = useAudioGenerationStore(
    (state) =>
      state.gallery.length > 0 ||
      state.generating ||
      state.loadingModelId !== null
  )

  useEffect(() => {
    void useAudioGenerationStore.getState().bind()
  }, [])

  const onErrorAction = useCallback((action: AudioErrorAction) => {
    const store = useAudioGenerationStore.getState()
    store.clearError()
    if (action === 'install') void store.installEngine()
    else if (action === 'chooseModel') setModelsOpen(true)
    else void store.generate()
  }, [])

  const canPickModel = core === 'ready' && !modelReady

  return (
    <MediaStudioFrame testId="audio-generation-page">
      <aside className="col-start-1 row-start-1 flex min-h-0 min-w-0 flex-col border-r border-border">
        <AudioPromptForm
          modelsOpen={modelsOpen}
          onModelsOpenChange={setModelsOpen}
        />
      </aside>
      <section className="relative col-start-2 row-start-1 flex min-h-0 min-w-0 flex-col overflow-hidden">
        {lastError && (
          <div className="shrink-0 px-6 pt-3">
            <AudioErrorBanner
              error={lastError}
              onAction={onErrorAction}
              onDismiss={clearError}
            />
          </div>
        )}
        {hasContent ? (
          <AudioResultsPane />
        ) : (
          <div className="min-h-0 flex-1">
            <ImageEmptyState
              modality="audio"
              modelPicked={!canPickModel}
              onDownloadModel={
                canPickModel ? () => setModelsOpen(true) : undefined
              }
            />
          </div>
        )}
      </section>
    </MediaStudioFrame>
  )
})
