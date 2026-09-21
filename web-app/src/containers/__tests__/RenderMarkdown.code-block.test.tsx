import { fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RenderMarkdown } from '../RenderMarkdown'
import {
  CodeBlock,
  CodeBlockCopyButton,
} from '@/components/ai-elements/code-block'

const source = `Get-Content "C:\\Users\\Danny\\${'LongFolder\\'.repeat(30)}results.csv"\n\n    Write-Output "${'token'.repeat(200)}"\nname,path\nDanny,C:\\exports\\results.csv`

afterEach(() => vi.restoreAllMocks())

describe('chat code source preservation', () => {
  it.each([false, true])(
    'keeps highlighted lines, copy and download intact (HTML preview: %s)',
    async (enableHtmlPreview) => {
      let copied = ''
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            copied = text
          },
        },
      })
      let downloaded: Blob | undefined
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: (blob: Blob) => {
          downloaded = blob as Blob
          return 'blob:code-download'
        },
      })
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        value: () => {},
      })
      let fileName = ''
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
        function (this: HTMLAnchorElement) {
          fileName = this.download
        }
      )
      const { container } = render(
        <RenderMarkdown
          content={`\`\`\`powershell\n${source}\n\`\`\``}
          enableHtmlPreview={enableHtmlPreview}
          isAnimating={false}
        />
      )
      await waitFor(() => {
        const code = container.querySelector(
          '[data-streamdown="code-block-body"] code'
        )!
        expect(
          [...code.children].map((line) => line.textContent).join('\n')
        ).toBe(source)
        expect(code.querySelector('span[style]')).toBeTruthy()
      })
      expect(
        container.querySelector('[data-streamdown="code-block-header"]')
          ?.textContent
      ).toContain('powershell')
      fireEvent.click(
        container.querySelector('[data-streamdown="code-block-copy-button"]')!
      )
      await waitFor(() => expect(copied.replace(/\n+$/, '')).toBe(source))
      fireEvent.click(
        container.querySelector(
          '[data-streamdown="code-block-download-button"]'
        )!
      )
      await waitFor(() => expect(downloaded).toBeInstanceOf(Blob))
      const downloadedText = await new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.readAsText(downloaded!)
      })
      expect(downloadedText).toBe(copied)
      expect(fileName).toMatch(/\.ps1$/)
    }
  )

  it('keeps shared CodeBlock text and clipboard contents unchanged', async () => {
    let copied = ''
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copied = text
        },
      },
    })
    const { container, getByRole } = render(
      <CodeBlock code={source} language="powershell">
        <CodeBlockCopyButton aria-label="Copy code" />
      </CodeBlock>
    )
    await waitFor(() => {
      const blocks = container.querySelectorAll('pre code')
      expect(blocks).toHaveLength(2)
      for (const block of blocks) {
        expect(block.textContent).toBe(source)
        expect(block.querySelector('span[style]')).toBeTruthy()
      }
    })
    fireEvent.click(getByRole('button', { name: 'Copy code' }))
    await waitFor(() => expect(copied).toBe(source))
  })
})
