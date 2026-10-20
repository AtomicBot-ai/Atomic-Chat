import { beforeEach, describe, expect, it } from 'vitest'
import { MODEL_LIKES_STORAGE_KEY, useModelLikes } from '../useModelLikes'

describe('useModelLikes', () => {
  beforeEach(() => {
    localStorage.clear()
    useModelLikes.setState({ liked: [], onlyLiked: false })
  })

  it('toggles a heart on and off, oldest first', () => {
    const { toggle } = useModelLikes.getState()
    toggle('a/one')
    toggle('b/two')
    expect(useModelLikes.getState().liked).toEqual(['a/one', 'b/two'])
    toggle('a/one')
    expect(useModelLikes.getState().liked).toEqual(['b/two'])
  })

  it('keeps the hearts on this device and the Liked filter for this launch only', () => {
    useModelLikes.getState().toggle('a/one')
    useModelLikes.getState().setOnlyLiked(true)

    const saved = JSON.parse(localStorage.getItem(MODEL_LIKES_STORAGE_KEY)!)
    expect(MODEL_LIKES_STORAGE_KEY).toBe('atomic-model-likes')
    expect(saved.state).toEqual({ liked: ['a/one'] })
  })
})
