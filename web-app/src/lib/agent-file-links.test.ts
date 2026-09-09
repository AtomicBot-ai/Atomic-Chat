import { describe, expect, it } from 'vitest'
import {
  agentFilePathFromHref,
  agentMediaPathFromHref,
  extractAgentAttachmentReferences,
  extractAgentToolPaths,
  linkAgentFileReferences,
  linkAgentLocalMedia,
  resolveAgentLocalPath,
} from './agent-file-links'

describe('agent media images', () => {
  const workingDir =
    '/Users/misha/Library/Application Support/Atomic Chat/data/agent-workspace'

  it('resolves a bare file name against the working directory', () => {
    expect(resolveAgentLocalPath('porsche-preview.gif', { workingDir })).toBe(
      `${workingDir}/porsche-preview.gif`
    )
    expect(resolveAgentLocalPath('./clips/out.mp4', { workingDir })).toBe(
      `${workingDir}/clips/out.mp4`
    )
  })

  it('prefers a known file with the same name over the working directory', () => {
    expect(
      resolveAgentLocalPath('out.mp4', {
        workingDir,
        references: ['/Users/misha/Desktop/renders/out.mp4'],
      })
    ).toBe('/Users/misha/Desktop/renders/out.mp4')
  })

  it('keeps absolute and file:// paths, and leaves remote sources alone', () => {
    expect(resolveAgentLocalPath('/tmp/a.png')).toBe('/tmp/a.png')
    expect(resolveAgentLocalPath('file:///Users/misha/a%20b.mov')).toBe(
      '/Users/misha/a b.mov'
    )
    expect(resolveAgentLocalPath('file:///C:/Users/misha/a.mp4')).toBe(
      'C:/Users/misha/a.mp4'
    )
    expect(resolveAgentLocalPath('https://cdn.example.com/a.mp4')).toBeNull()
    expect(resolveAgentLocalPath('data:image/png;base64,AAAA')).toBeNull()
    expect(resolveAgentLocalPath('nothing.gif')).toBeNull()
  })

  it('rewrites local Markdown images into media links, skipping code', () => {
    const content = [
      'Preview:',
      '',
      '![Video preview](porsche-preview.gif)',
      '![](/Users/misha/Desktop/spot.mp4 "title")',
      '![remote](https://cdn.example.com/a.png)',
      '`![inline](x.gif)`',
      '```',
      '![fenced](y.gif)',
      '```',
    ].join('\n')

    const linked = linkAgentLocalMedia(content, { workingDir })

    expect(linked).toContain(
      `[Video preview](https://atomic.local/media?path=${encodeURIComponent(
        `${workingDir}/porsche-preview.gif`
      )})`
    )
    expect(linked).toContain(
      `[spot.mp4](https://atomic.local/media?path=${encodeURIComponent(
        '/Users/misha/Desktop/spot.mp4'
      )})`
    )
    expect(linked).toContain('![remote](https://cdn.example.com/a.png)')
    expect(linked).toContain('`![inline](x.gif)`')
    expect(linked).toContain('![fenced](y.gif)')
  })

  it('turns local links into inline media or open-file links', () => {
    const content = [
      '[▶ Preview qwenCOD-v2.mp4](file:///Users/misha/Downloads/qwenCOD-v2.mp4)',
      '[the report](/Users/misha/Desktop/report.pdf)',
      'or just file:///Users/misha/Downloads/clip.mov here',
      '[docs](https://example.com/a.mp4)',
    ].join('\n')

    const linked = linkAgentLocalMedia(content, { workingDir })

    expect(linked).toContain(
      `[▶ Preview qwenCOD-v2.mp4](https://atomic.local/media?path=${encodeURIComponent(
        '/Users/misha/Downloads/qwenCOD-v2.mp4'
      )})`
    )
    expect(linked).toContain(
      `[the report](https://atomic.local/open-file?path=${encodeURIComponent(
        '/Users/misha/Desktop/report.pdf'
      )})`
    )
    expect(linked).toContain(
      `[clip.mov](https://atomic.local/media?path=${encodeURIComponent(
        '/Users/misha/Downloads/clip.mov'
      )})`
    )
    expect(linked).toContain('[docs](https://example.com/a.mp4)')
    expect(linked).not.toContain('file://')
  })

  it('leaves an image of a non-media file and already-rewritten links alone', () => {
    const once = linkAgentLocalMedia('![x](/tmp/a.pdf) ![y](/tmp/b.mp4)', {})
    expect(once).toContain('![x](/tmp/a.pdf)')
    expect(linkAgentLocalMedia(once, {})).toBe(once)
  })

  it('round-trips the media link back to the path', () => {
    const linked = linkAgentLocalMedia('![a](</tmp/a b.mp4>)')
    const href = linked.slice(linked.indexOf('(') + 1, -1)
    expect(agentMediaPathFromHref(href)).toBe('/tmp/a b.mp4')
    expect(agentMediaPathFromHref('https://example.com')).toBeNull()
  })

  it('survives the file-reference linker running afterwards', () => {
    const content = 'Saved spot.mp4 and here it is: ![clip](spot.mp4)'
    const references = ['/Users/misha/Desktop/spot.mp4']
    const linked = linkAgentFileReferences(
      linkAgentLocalMedia(content, { workingDir, references }),
      references
    )
    expect(linked).toContain('[spot.mp4](https://atomic.local/open-file?path=')
    expect(linked).toContain('[clip](https://atomic.local/media?path=')
    expect(linked).not.toContain('![')
  })
})

describe('agent file links', () => {
  it('extracts absolute paths from agent tool inputs', () => {
    expect(
      extractAgentToolPaths([
        {
          type: 'tool-os.fs.write',
          input: { path: '/Users/misha/Desktop/summary.txt', content: 'ok' },
        },
        {
          type: 'tool-os.fs.read',
          input: { path: 'attachment://spec.pdf' },
        },
      ])
    ).toEqual(['/Users/misha/Desktop/summary.txt'])
  })

  it('extracts supported Windows paths and rejects device namespaces', () => {
    expect(
      extractAgentToolPaths([
        {
          type: 'tool-os.fs.write',
          input: { path: '\\\\?\\C:\\Users\\Misha\\summary.txt' },
        },
        {
          type: 'tool-os.fs.read',
          input: { path: '\\\\server\\share\\report.txt' },
        },
        {
          type: 'tool-os.fs.read',
          input: { path: '\\\\.\\C:\\device.txt' },
        },
        {
          type: 'tool-os.fs.read',
          input: { path: '\\\\?\\GLOBALROOT\\Device\\file.txt' },
        },
      ])
    ).toEqual([
      '\\\\?\\C:\\Users\\Misha\\summary.txt',
      '\\\\server\\share\\report.txt',
    ])
  })

  it('extracts named attachment paths from file parts', () => {
    expect(
      extractAgentAttachmentReferences([
        {
          type: 'file',
          filename: 'Техническое задание.pdf',
          url: '/thread/agent-attachments/turn/01.pdf',
        },
        {
          type: 'file',
          filename: 'image.png',
          url: 'data:image/png;base64,aGVsbG8=',
        },
      ])
    ).toEqual([
      {
        name: 'Техническое задание.pdf',
        path: '/thread/agent-attachments/turn/01.pdf',
      },
    ])
  })

  it('links both a full path and its unique basename using filename labels', () => {
    const path = '/Users/misha/Desktop/summary.txt'
    const linked = linkAgentFileReferences(
      `Created ${path}. Open summary.txt.`,
      [path]
    )

    expect(linked).toContain(
      `[summary.txt](https://atomic.local/open-file?path=${encodeURIComponent(path)})`
    )
    expect(linked).not.toContain(`[${path}]`)
  })

  it('links an attachment by its original filename', () => {
    const path = '/thread/agent-attachments/turn/01.pdf'

    expect(
      linkAgentFileReferences('Открыть Техническое задание.pdf', [
        { path, name: 'Техническое задание.pdf' },
      ])
    ).toContain(
      `[Техническое задание.pdf](https://atomic.local/open-file?path=${encodeURIComponent(path)})`
    )
  })

  it('hides a staged attachment path behind its original filename', () => {
    const path = '/thread/agent-attachments/turn/01.pdf'

    expect(
      linkAgentFileReferences(`Создано в ${path}`, [
        { path, name: 'Техническое задание.pdf' },
      ])
    ).toContain(
      `[Техническое задание.pdf](https://atomic.local/open-file?path=${encodeURIComponent(path)})`
    )
  })

  it('does not link an ambiguous basename', () => {
    const first = '/tmp/one/summary.txt'
    const second = '/tmp/two/summary.txt'

    expect(linkAgentFileReferences('Open summary.txt.', [first, second])).toBe(
      'Open summary.txt.'
    )
  })

  it('does not rewrite existing links or code', () => {
    const path = '/tmp/summary.txt'

    expect(
      linkAgentFileReferences(
        '`summary.txt` [summary.txt](https://example.com)',
        [path]
      )
    ).toBe('`summary.txt` [summary.txt](https://example.com)')
  })

  it('decodes only Atomic Chat file hrefs', () => {
    const path = 'C:\\Users\\Misha\\summary.txt'
    const href = `https://atomic.local/open-file?path=${encodeURIComponent(path)}`

    expect(agentFilePathFromHref(href)).toBe(path)
    expect(agentFilePathFromHref('https://example.com')).toBeNull()
  })
})
