import { beforeEach, describe, expect, it } from 'vitest'

import { useMediaLastUsedStore } from '../media-last-used-store'

describe('media last used store', () => {
  beforeEach(() => useMediaLastUsedStore.setState({ byTask: {} }))

  it('keeps what was tuned but never the prompt or the seed', () => {
    useMediaLastUsedStore.getState().record({
      client_job_id: 'j',
      provider_id: 'p',
      model_id: 'p:m',
      task: 'text_to_image',
      params: { prompt: 'secret', seed: 7, steps: 20 },
      device: 'gpu0',
    })
    expect(useMediaLastUsedStore.getState().byTask.text_to_image).toEqual({
      provider_id: 'p',
      model_id: 'p:m',
      params: { steps: 20 },
      device: 'gpu0',
    })
  })
})
