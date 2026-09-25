import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const features = vi.hoisted(() => ({ media: true }))
vi.mock('@/lib/platform/const', () => ({
  PlatformFeatures: new Proxy(
    {},
    { get: (_target, key) => (key === 'mediaGeneration' ? features.media : true) }
  ),
}))
vi.mock('@/lib/platform/types', () => ({
  PlatformFeature: { MEDIA_GENERATION: 'mediaGeneration' },
}))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({}),
  getServiceHub: () => ({}),
}))
const store = vi.hoisted(() => ({
  bind: vi.fn(async () => {}),
  unbind: vi.fn(),
}))
vi.mock('@/stores/video-generation-store', () => ({
  useVideoGenerationStore: (selector: (state: typeof store) => unknown) =>
    selector(store),
}))

import { VideoGenerationProvider } from '../VideoGenerationProvider'

describe('VideoGenerationProvider', () => {
  beforeEach(() => {
    features.media = true
    store.bind.mockClear()
    store.unbind.mockClear()
  })

  it('binds the video job store for the life of the app and unbinds on unmount', () => {
    const { container, unmount } = render(<VideoGenerationProvider />)
    expect(container).toBeEmptyDOMElement()
    expect(store.bind).toHaveBeenCalledTimes(1)
    unmount()
    expect(store.unbind).toHaveBeenCalledTimes(1)
  })

  it('does nothing on a platform without media generation', () => {
    features.media = false
    const { unmount } = render(<VideoGenerationProvider />)
    unmount()
    expect(store.bind).not.toHaveBeenCalled()
    expect(store.unbind).not.toHaveBeenCalled()
  })
})
