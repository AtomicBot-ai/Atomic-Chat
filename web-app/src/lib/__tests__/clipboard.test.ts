import { describe, it, expect, vi, afterEach } from 'vitest'
import { copyToClipboard } from '../clipboard'

const setClipboard = (value: unknown) => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value,
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  setClipboard(undefined)
})

describe('copyToClipboard', () => {
  it('reports success when the write lands', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    setClipboard({ writeText })

    await expect(copyToClipboard('hello')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('reports failure instead of rejecting when access is denied', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setClipboard({
      writeText: vi
        .fn()
        .mockRejectedValue(
          new DOMException('The request is not allowed', 'NotAllowedError')
        ),
    })

    await expect(copyToClipboard('hello')).resolves.toBe(false)
    expect(warn).toHaveBeenCalled()
  })

  it('reports failure when the clipboard API is absent', async () => {
    setClipboard(undefined)

    await expect(copyToClipboard('hello')).resolves.toBe(false)
  })
})
