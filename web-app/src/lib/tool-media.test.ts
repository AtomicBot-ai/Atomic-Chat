import { describe, expect, it } from 'vitest'
import { extractTextVideos, extractToolMedia, MAX_TOOL_MEDIA } from './tool-media'

describe('extractToolMedia', () => {
  it('finds image and video URLs in MCP text content (chat mode)', () => {
    const output = {
      content: [
        {
          type: 'text',
          text: 'Done.\nrawUrl: https://cdn.example.com/a/clip.mp4?sig=1\nthumb: https://cdn.example.com/a/clip.jpg\nsee https://docs.example.com/page.',
        },
      ],
    }
    expect(extractToolMedia(output)).toEqual([
      { kind: 'video', url: 'https://cdn.example.com/a/clip.mp4?sig=1' },
      { kind: 'image', url: 'https://cdn.example.com/a/clip.jpg' },
    ])
  })

  it('reads typed generation records without relying on extensions', () => {
    const output = {
      generation: {
        id: 'job-1',
        type: 'video',
        status: 'completed',
        results: {
          rawUrl: 'https://cdn.example.com/render/abc',
          thumbnailUrl: 'https://cdn.example.com/render/abc-thumb.jpg',
        },
      },
    }
    expect(extractToolMedia(output)).toEqual([
      {
        kind: 'video',
        url: 'https://cdn.example.com/render/abc',
        poster: 'https://cdn.example.com/render/abc-thumb.jpg',
      },
    ])
  })

  it('reads the jobs_wait shape and keeps posters out of the image list', () => {
    const output = {
      jobs: [
        {
          index: 0,
          job_id: 'j',
          status: 'completed',
          type: 'image',
          result_url: 'https://cdn.example.com/i.png',
        },
        {
          index: 1,
          job_id: 'k',
          status: 'completed',
          type: 'video',
          result_url: 'https://cdn.example.com/v.mp4',
          thumbnail_url: 'https://cdn.example.com/v.jpg',
        },
      ],
    }
    expect(extractToolMedia(output)).toEqual([
      { kind: 'image', url: 'https://cdn.example.com/i.png' },
      {
        kind: 'video',
        url: 'https://cdn.example.com/v.mp4',
        poster: 'https://cdn.example.com/v.jpg',
      },
    ])
  })

  it('parses the JSON strings an agent-mode MCP outcome carries', () => {
    const output = {
      status: 'ok',
      summary: 'id: job-1',
      details: {
        mcp: true,
        content: JSON.stringify([{ type: 'text', text: 'id: job-1' }]),
        structuredContent: JSON.stringify({
          generation: {
            type: 'image',
            results: { rawUrl: 'https://cdn.example.com/out.webp' },
          },
        }),
      },
    }
    expect(extractToolMedia(output)).toEqual([
      { kind: 'image', url: 'https://cdn.example.com/out.webp' },
    ])
  })

  it('ignores non-media URLs, data URLs and base64 image items', () => {
    const output = {
      content: [
        { type: 'text', text: 'https://example.com/report.pdf and https://example.com/' },
        { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
      ],
    }
    expect(extractToolMedia(output)).toEqual([])
  })

  it('dedupes and caps the gallery', () => {
    const urls = Array.from(
      { length: MAX_TOOL_MEDIA + 5 },
      (_, i) => `https://cdn.example.com/${i}.png`
    )
    const text = [...urls, ...urls].join(' ')
    expect(extractToolMedia(text)).toHaveLength(MAX_TOOL_MEDIA)
  })

  it('handles plain strings, nulls and cycles-free depth without throwing', () => {
    expect(extractToolMedia(null)).toEqual([])
    expect(extractToolMedia('nothing here')).toEqual([])
    expect(extractToolMedia('{not json https://x.test/a.mov')).toEqual([
      { kind: 'video', url: 'https://x.test/a.mov' },
    ])
  })
})

describe('extractTextVideos', () => {
  it('returns only videos from assistant prose', () => {
    expect(
      extractTextVideos(
        'Here it is: https://cdn.example.com/spot.mp4 (and a still https://cdn.example.com/still.png)'
      )
    ).toEqual([{ kind: 'video', url: 'https://cdn.example.com/spot.mp4' }])
    expect(extractTextVideos('no links')).toEqual([])
  })
})
