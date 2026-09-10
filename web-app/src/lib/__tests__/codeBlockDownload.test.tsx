import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))

const save = vi.fn(async () => null)
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({ dialog: () => ({ save }) }),
  isServiceHubInitialized: () => true,
}))

vi.mock('@/hooks/useThreads', () => ({
  useThreads: { getState: () => ({ getCurrentThread: () => undefined }) },
}))

import { RenderMarkdown } from '@/containers/RenderMarkdown'
import { installCodeBlockDownloadHandler } from '../codeBlockDownload'

/**
 * End-to-end cover for issue #255: the filename has to survive the whole trip
 * from the model's markdown, through streamdown's DOM, to the save dialog.
 * Only the Tauri seam is mocked.
 */
const downloadFrom = async (content: string): Promise<string | undefined> => {
  const { container, findByText } = render(
    <RenderMarkdown content={content} enableHtmlPreview />
  )
  await findByText('body', { exact: false }).catch(() => null)

  // Shiki highlights asynchronously, and the button only exists once the
  // block is rendered.
  const button = await waitFor(
    () => {
      const found = container.querySelector<HTMLElement>(
        '[data-streamdown="code-block-download-button"]'
      )
      if (!found) throw new Error('download button not rendered')
      return found
    },
    { timeout: 10000 }
  )

  button.click()
  await waitFor(() => expect(save).toHaveBeenCalled())
  return save.mock.calls.at(-1)?.[0]?.defaultPath
}

describe('code-block download filename', () => {
  beforeEach(() => {
    save.mockClear()
    invoke.mockClear()
    installCodeBlockDownloadHandler()
  })

  it('uses the filename from the fence info string', async () => {
    expect(
      await downloadFrom(
        ['```css title="styles.css"', 'body { color: red; }', '```'].join('\n') + '\n'
      )
    ).toBe('styles.css')
  })

  it('uses the filename from a leading comment', async () => {
    expect(
      await downloadFrom(
        ['```js', '// data/content.js', 'export const a = 1', '```'].join('\n') + '\n'
      )
      // Directories are dropped: a save dialog rejects them in defaultPath.
    ).toBe('content.js')
  })

  it('uses a filename printed as prose above the block', async () => {
    expect(
      await downloadFrom(
        ['**js/main.js**', '', '```js', 'const a = 1', '```'].join('\n') + '\n'
      )
    ).toBe('main.js')
  })

  it('falls back to file.<ext> when nothing names the file', async () => {
    expect(
      await downloadFrom(['```css', 'body { color: red; }', '```'].join('\n') + '\n')
    ).toBe('file.css')
  })

  it('ignores prose that is not a filename for this language', async () => {
    expect(
      await downloadFrom(
        ['See example.com for details.', '', '```js', 'const a = 1', '```'].join(
          '\n'
        )
      )
    ).toBe('file.js')
  })
})
