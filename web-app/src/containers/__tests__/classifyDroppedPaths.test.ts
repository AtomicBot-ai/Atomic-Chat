import { describe, expect, it } from 'vitest'

import { classifyDroppedPaths } from '@/containers/chatInput/classifyDroppedPaths'

describe('classifyDroppedPaths', () => {
  it('routes images, audio, videos, docs and unsupported separately', () => {
    const result = classifyDroppedPaths([
      '/tmp/photo.png',
      '/tmp/scan.JPG',
      '/tmp/voice.mp3',
      '/tmp/clip.WAV',
      '/tmp/song.flac',
      '/tmp/audio.ogg',
      '/tmp/demo.mp4',
      '/tmp/screen.MOV',
      '/tmp/movie.mkv',
      '/tmp/report.pdf',
      '/tmp/notes.md',
      '/tmp/archive.zip',
      '/tmp/tool.exe',
    ])
    expect(result.images).toEqual(['/tmp/photo.png', '/tmp/scan.JPG'])
    // Only mp3/wav are accepted as audio; FLAC/OGG fall through to unsupported.
    expect(result.audio).toEqual(['/tmp/voice.mp3', '/tmp/clip.WAV'])
    // Only containers the webview can play are accepted as video.
    expect(result.videos).toEqual(['/tmp/demo.mp4', '/tmp/screen.MOV'])
    expect(result.docs).toEqual(['/tmp/report.pdf', '/tmp/notes.md'])
    expect(result.unsupported).toEqual([
      '/tmp/song.flac',
      '/tmp/audio.ogg',
      '/tmp/movie.mkv',
      '/tmp/archive.zip',
      '/tmp/tool.exe',
    ])
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
      audio: [],
      videos: [],
      docs: [],
      unsupported: [],
    })
  })
})
