import { beforeEach, describe, expect, it, vi } from 'vitest'

import { readImageAttachmentFromPath } from '../imageFromPath'
import { readAudioAttachmentFromPath } from '../audioFromPath'

const readFileBytes = vi.fn()

vi.mock('@/lib/readFileBytes', () => ({
  readFileBytes: (...args: unknown[]) => readFileBytes(...args),
}))

// PNG signature, enough to be recognisable in the base64 output.
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
])

beforeEach(() => {
  readFileBytes.mockReset()
  readFileBytes.mockResolvedValue({ bytes: PNG_BYTES, size: PNG_BYTES.length })
})

describe('readImageAttachmentFromPath', () => {
  it('builds an image attachment from the bytes on disk', async () => {
    const att = await readImageAttachmentFromPath(
      'F:\\out\\ComfyUI_00001_.png',
      { maxBytes: 64 * 1024 * 1024 }
    )

    expect(readFileBytes).toHaveBeenCalledWith('F:\\out\\ComfyUI_00001_.png', {
      maxBytes: 64 * 1024 * 1024,
    })
    expect(att.type).toBe('image')
    expect(att.name).toBe('ComfyUI_00001_.png')
    expect(att.mimeType).toBe('image/png')
    expect(att.size).toBe(PNG_BYTES.length)
    expect(att.dataUrl).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(att.base64).toBe('iVBORw0KGgo=')
  })

  it('lets a read failure through untouched', async () => {
    readFileBytes.mockRejectedValue(new Error('Access is denied'))

    await expect(
      readImageAttachmentFromPath('/img/a.png', { maxBytes: 1 })
    ).rejects.toThrow('Access is denied')
  })
})

describe('readAudioAttachmentFromPath', () => {
  it('builds an audio attachment with the extension-derived mime type', async () => {
    const att = await readAudioAttachmentFromPath('/audio/clip.wav', {
      maxBytes: 25 * 1024 * 1024,
    })

    expect(att.type).toBe('audio')
    expect(att.name).toBe('clip.wav')
    expect(att.mimeType).toBe('audio/wav')
    expect(att.size).toBe(PNG_BYTES.length)
    expect(att.dataUrl.startsWith('data:audio/wav;base64,')).toBe(true)
  })
})
