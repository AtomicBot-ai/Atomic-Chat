import { beforeEach, describe, expect, it } from 'vitest'
import { getHubSearchQuery, setHubSearchQuery } from '../hub-session'

describe('Hub session state', () => {
  beforeEach(() => {
    setHubSearchQuery('')
  })

  it('keeps the latest model search query for the session', () => {
    setHubSearchQuery('qwen coder')

    expect(getHubSearchQuery()).toBe('qwen coder')

    setHubSearchQuery('')

    expect(getHubSearchQuery()).toBe('')
  })
})
