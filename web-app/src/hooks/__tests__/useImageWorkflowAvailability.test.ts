import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  makeCapabilities,
  makeLoadedStatus,
  makeStatus,
  Q4_ID,
} from '@/lib/diffusion/__tests__/image-fixtures'
import { useImageSetting } from '@/hooks/useImageSetting'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { useImageWorkflowAvailability } from '../useImageWorkflowAvailability'

describe('useImageWorkflowAvailability', () => {
  beforeEach(async () => {
    localStorage.clear()
    await useImageSetting.persist.rehydrate()
    useImageSetting.setState({ selectedArtifactId: null })
    useImageGenerationStore.getState().reset()
  })

  it('offers everything when nothing is loaded or selected', () => {
    const { result } = renderHook(() => useImageWorkflowAvailability())
    expect(result.current.isAvailable('edit')).toBe(true)
    expect(result.current.unavailableReason).toBeNull()
  })

  it('follows the selected checkpoint by family before anything is loaded', () => {
    useImageSetting.setState({ selectedArtifactId: Q4_ID })
    useImageGenerationStore.setState({ status: makeStatus() })
    const { result } = renderHook(() => useImageWorkflowAvailability())
    expect(result.current.isAvailable('inpaint')).toBe(true)
    expect(result.current.isAvailable('edit')).toBe(false)
    expect(result.current.unavailableReason).toBe('selected')

    useImageSetting.setState({ selectedArtifactId: 'flux.2-klein:q4_k_m' })
    const { result: klein } = renderHook(() => useImageWorkflowAvailability())
    expect(klein.current.isAvailable('edit')).toBe(true)
  })

  it('lets the loaded model override the selection', () => {
    useImageSetting.setState({ selectedArtifactId: 'flux.2-klein:q4_k_m' })
    useImageGenerationStore.setState({
      status: makeLoadedStatus(Q4_ID),
      capabilities: makeCapabilities({ workflows: ['create', 'transform'] }),
    })
    const { result } = renderHook(() => useImageWorkflowAvailability())
    expect(result.current.isAvailable('transform')).toBe(true)
    expect(result.current.isAvailable('edit')).toBe(false)
    expect(result.current.unavailableReason).toBe('loaded')
  })
})
