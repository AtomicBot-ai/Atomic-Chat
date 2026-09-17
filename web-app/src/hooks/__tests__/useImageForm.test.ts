import { beforeEach, describe, expect, it } from 'vitest'

import { localStorageKey } from '@/constants/localStorage'
import { makeCapabilities } from '@/lib/diffusion/__tests__/image-fixtures'
import {
  DEFAULT_IMAGE_FORM,
  DEFAULT_WORKFLOW_KNOBS,
  useImageForm,
} from '../useImageForm'

describe('useImageForm', () => {
  beforeEach(async () => {
    localStorage.clear()
    await useImageForm.persist.rehydrate()
    useImageForm.setState({
      ...DEFAULT_IMAGE_FORM,
      ...DEFAULT_WORKFLOW_KNOBS,
      sourceImage: null,
      maskBase64: null,
      maskResetKey: 0,
      referenceImages: [],
    })
  })

  it('persists the knobs but never the images, the mask or the workflow', () => {
    useImageForm.setState({
      workflow: 'inpaint',
      strength: 0.4,
      expandPercent: 40,
      sourceImage: { path: '/in.png', width: 10, height: 10 },
      maskBase64: 'data:image/png;base64,QUJD',
      referenceImages: ['/ref.png'],
    })
    const stored = JSON.parse(localStorage.getItem(localStorageKey.imageForm) ?? '{}')
    expect(stored.state.strength).toBe(0.4)
    expect(stored.state.expandPercent).toBe(40)
    expect(stored.state).not.toHaveProperty('workflow')
    expect(stored.state).not.toHaveProperty('sourceImage')
    expect(stored.state).not.toHaveProperty('maskBase64')
    expect(stored.state).not.toHaveProperty('referenceImages')
  })

  it('drops the mask when the source changes and on Clear mask', () => {
    useImageForm.setState({ maskBase64: 'data:image/png;base64,QUJD' })
    const before = useImageForm.getState().maskResetKey
    useImageForm.getState().setSourceImage({ path: '/other.png', width: 1, height: 1 })
    expect(useImageForm.getState().maskBase64).toBeNull()
    expect(useImageForm.getState().maskResetKey).toBe(before + 1)

    useImageForm.setState({ maskBase64: 'data:image/png;base64,QUJD' })
    useImageForm.getState().clearMask()
    expect(useImageForm.getState().maskBase64).toBeNull()
    expect(useImageForm.getState().sourceImage?.path).toBe('/other.png')
  })

  it('caps the extra references at three', () => {
    const { addReference, removeReference } = useImageForm.getState()
    for (const path of ['/1.png', '/2.png', '/3.png', '/4.png']) addReference(path)
    expect(useImageForm.getState().referenceImages).toEqual(['/1.png', '/2.png', '/3.png'])
    removeReference(1)
    expect(useImageForm.getState().referenceImages).toEqual(['/1.png', '/3.png'])
  })

  it('leaves the workflow alone when clamping to a model that lacks it', () => {
    useImageForm.setState({ workflow: 'edit', width: 1000, height: 700 })
    useImageForm.getState().clampTo(makeCapabilities({ workflows: ['create'] }))
    const state = useImageForm.getState()
    expect(state.workflow).toBe('edit')
    expect(state.width).toBe(1008)
  })

  it('resets the workflow knobs with the rest of the numbers', () => {
    useImageForm.setState({ strength: 0.2, upscaleFactor: 4, prompt: 'keep' })
    useImageForm.getState().resetToDefaults({ steps: 8, cfgScale: 1, width: 1024, height: 1024 })
    const state = useImageForm.getState()
    expect(state.strength).toBe(DEFAULT_WORKFLOW_KNOBS.strength)
    expect(state.upscaleFactor).toBe(DEFAULT_WORKFLOW_KNOBS.upscaleFactor)
    expect(state.prompt).toBe('keep')
  })
})
