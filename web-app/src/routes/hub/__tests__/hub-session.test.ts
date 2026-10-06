import { beforeEach, describe, expect, it } from 'vitest'
import { getHubFormat, getHubSearchQuery, setHubFormat, setHubSearchQuery } from '../hub-session'

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

  it('keeps the picked format for the launch only, none at first', () => {
    setHubFormat(null)
    expect(getHubFormat()).toBeNull()
    setHubFormat('tensorrt-llm')
    expect(getHubFormat()).toBe('tensorrt-llm')
  })
})
