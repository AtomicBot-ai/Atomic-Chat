import { describe, expect, it } from 'vitest'

import { classifyDroppedPaths } from '@/containers/chatInput/classifyDroppedPaths'

describe('classifyDroppedPaths', () => {
  it('routes images, docs and unsupported separately', () => {
    const result = classifyDroppedPaths([
      '/tmp/photo.png',
      '/tmp/scan.JPG',
      '/tmp/report.pdf',
      '/tmp/notes.md',
      '/tmp/archive.zip',
      '/tmp/tool.exe',
    ])
    expect(result.images).toEqual(['/tmp/photo.png', '/tmp/scan.JPG'])
    expect(result.docs).toEqual(['/tmp/report.pdf', '/tmp/notes.md'])
    expect(result.unsupported).toEqual(['/tmp/archive.zip', '/tmp/tool.exe'])
  })

  it('handles paths without extensions and Windows separators', () => {
    const result = classifyDroppedPaths([
      'C:\\Users\\me\\Documents\\readme',
      'C:\\Users\\me\\Documents\\spec.docx',
    ])
    expect(result.images).toEqual([])
    expect(result.docs).toEqual(['C:\\Users\\me\\Documents\\spec.docx'])
    expect(result.unsupported).toEqual(['C:\\Users\\me\\Documents\\readme'])
  })

  it('returns empty buckets for empty input', () => {
    expect(classifyDroppedPaths([])).toEqual({
      images: [],
      docs: [],
      unsupported: [],
    })
  })
})
