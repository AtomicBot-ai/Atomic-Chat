import { describe, expect, it } from 'vitest'
import {
  agentFilePathFromHref,
  extractAgentAttachmentReferences,
  extractAgentToolPaths,
  linkAgentFileReferences,
} from './agent-file-links'

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

  it('links a home-relative shorthand for an absolute macOS path', () => {
    const path = '/Users/atomic/Desktop/uncensored-ai-models.pdf'

    expect(
      linkAgentFileReferences(
        '👉 ** ~/Desktop/uncensored-ai-models.pdf**',
        [path]
      )
    ).toBe(
      `👉 ** [uncensored-ai-models.pdf](https://atomic.local/open-file?path=${encodeURIComponent(path)})**`
    )
  })

  it('links a home-relative shorthand for an absolute Linux path', () => {
    const path = '/home/atomic/Documents/report.pdf'

    expect(linkAgentFileReferences('Open ~/Documents/report.pdf', [path])).toBe(
      `Open [report.pdf](https://atomic.local/open-file?path=${encodeURIComponent(path)})`
    )
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

  it('does not link an ambiguous home-relative shorthand', () => {
    const first = '/Users/one/Desktop/summary.txt'
    const second = '/Users/two/Desktop/summary.txt'

    expect(
      linkAgentFileReferences('Open ~/Desktop/summary.txt.', [first, second])
    ).toBe('Open ~/Desktop/summary.txt.')
  })

  it('does not rewrite existing links or code', () => {
    const path = '/Users/atomic/Desktop/summary.txt'

    expect(
      linkAgentFileReferences(
        '`~/Desktop/summary.txt` [~/Desktop/summary.txt](https://example.com)\n```text\n~/Desktop/summary.txt\n```',
        [path]
      )
    ).toBe(
      '`~/Desktop/summary.txt` [~/Desktop/summary.txt](https://example.com)\n```text\n~/Desktop/summary.txt\n```'
    )
  })

  it('decodes only Atomic Chat file hrefs', () => {
    const path = 'C:\\Users\\Misha\\summary.txt'
    const href = `https://atomic.local/open-file?path=${encodeURIComponent(path)}`

    expect(agentFilePathFromHref(href)).toBe(path)
    expect(agentFilePathFromHref('https://example.com')).toBeNull()
  })
})
