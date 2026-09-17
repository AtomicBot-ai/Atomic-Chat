import { useShallow } from 'zustand/shallow'

import { useImageSetting } from '@/hooks/useImageSetting'
import { parseArtifactId } from '@/lib/diffusion/models'
import { familySupportsWorkflow } from '@/lib/diffusion/workflows'
import type { ImageWorkflowId } from '@/services/diffusion/types'
import { useImageGenerationStore } from '@/stores/image-generation-store'

export type WorkflowUnavailableReason = 'loaded' | 'selected'

/**
 * Which workflows the sidebar may offer right now. A resident model decides
 * first (what it reported it can run); with nothing loaded, the checkpoint
 * picked in the model list decides by its family; with neither, every
 * workflow is selectable — picking a workflow first and a model second is a
 * fine order, and the model list then says which models fit.
 *
 * Its own hook so the sidebar reads one small thing from the stores, and
 * tests of the sidebar mock one module.
 */
export function useImageWorkflowAvailability(): {
  isAvailable: (id: ImageWorkflowId) => boolean
  /** Why a workflow is off: the loaded model, or the selected one. */
  unavailableReason: WorkflowUnavailableReason | null
} {
  const { loaded, workflows } = useImageGenerationStore(
    useShallow((state) => ({
      loaded: state.status?.model.state === 'loaded',
      workflows: state.capabilities?.workflows ?? null,
    }))
  )
  const selectedFamily = useImageSetting(
    (state) => parseArtifactId(state.selectedArtifactId ?? '')?.family ?? null
  )
  if (loaded && workflows !== null) {
    return {
      isAvailable: (id) => workflows.includes(id),
      unavailableReason: 'loaded',
    }
  }
  if (selectedFamily) {
    return {
      isAvailable: (id) => familySupportsWorkflow(selectedFamily, id),
      unavailableReason: 'selected',
    }
  }
  return { isAvailable: () => true, unavailableReason: null }
}
