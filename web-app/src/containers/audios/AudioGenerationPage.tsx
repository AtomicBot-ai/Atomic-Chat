import { memo, useState } from 'react'

import { ImageEmptyState } from '@/containers/images/ImageEmptyState'
import { MediaStudioFrame } from '@/containers/images/MediaStudio'

import { AudioPromptForm } from './AudioPromptForm'

/**
 * Audios: speech, music and sound effects in the studio Images and Video
 * use — the form column on the left, the results pane on the right. There is
 * no audio engine yet (the page shows in dev builds only), so the pane stays
 * empty and points at the model list; the player and gallery come with the
 * engine.
 */
export const AudioGenerationPage = memo(function AudioGenerationPage() {
  const [modelsOpen, setModelsOpen] = useState(false)
  return (
    <MediaStudioFrame testId="audio-generation-page">
      <aside className="col-start-1 row-start-1 flex min-h-0 min-w-0 flex-col border-r border-border">
        <AudioPromptForm
          modelsOpen={modelsOpen}
          onModelsOpenChange={setModelsOpen}
        />
      </aside>
      <section className="relative col-start-2 row-start-1 flex min-h-0 min-w-0 flex-col overflow-hidden">
        <div className="min-h-0 flex-1">
          <ImageEmptyState
            modality="audio"
            modelPicked={false}
            onDownloadModel={() => setModelsOpen(true)}
          />
        </div>
      </section>
    </MediaStudioFrame>
  )
})
