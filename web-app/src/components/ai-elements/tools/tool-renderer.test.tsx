import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ToolRenderer } from './tool-renderer'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key}:${options.count}`,
  }),
}))

describe('ToolRenderer', () => {
  beforeAll(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    )
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  // ATO-529: a humanized verb ("Read file") hid which tool actually ran.
  it('names the tool that ran and what it ran with, without expanding', () => {
    render(
      <ToolRenderer
        toolName="os.fs.read"
        state="output-available"
        presentation={{
          kind: 'generic',
          title: 'Read file',
          subtitle: 'notes/nemotron.md',
          input: { path: 'notes/nemotron.md' },
          output: { content: 'hello' },
        }}
      />
    )

    const line = screen.getByRole('button')
    expect(line).toHaveTextContent('os.fs.read')
    expect(line).toHaveTextContent('notes/nemotron.md')
    expect(line).toHaveAttribute('title', 'Read file')
    expect(screen.queryByText('Parameters')).not.toBeInTheDocument()
  })

  it('opens parameters and output from the line itself', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <ToolRenderer
        toolName="os.fs.write"
        state="output-available"
        presentation={{
          kind: 'generic',
          title: 'Wrote file',
          subtitle: 'src/example.ts',
          input: {
            path: 'src/example.ts',
            content: 'export const first = 1\nexport const second = 2',
          },
          output: { ok: true },
        }}
      />
    )

    await user.click(screen.getByRole('button', { name: /os\.fs\.write/ }))

    expect(screen.getByText('Parameters')).toBeInTheDocument()
    expect(container).toHaveTextContent('export const first = 1')
  })

  it('shows why a call failed on its line', () => {
    render(
      <ToolRenderer
        toolName="web_fetch_exa"
        state="output-error"
        presentation={{
          kind: 'web_fetch_exa',
          title: 'Fetched pages',
          urls: ['https://developer.nvidia.com/nemotron'],
          pages: [],
          errorText: 'Failed to fetch URL: HTTP 404 Not Found\nat fetch()',
        }}
      />
    )

    const line = screen.getByRole('button')
    expect(line).toHaveTextContent('developer.nvidia.com')
    expect(line).toHaveTextContent('Failed to fetch URL: HTTP 404 Not Found')
    expect(line).not.toHaveTextContent('at fetch()')
  })

  it('says a call was denied rather than echoing an empty error', () => {
    render(
      <ToolRenderer
        toolName="os.shell.run"
        state={'output-denied' as never}
        presentation={{
          kind: 'generic',
          title: 'Command failed',
          subtitle: 'rm -rf build',
        }}
      />
    )

    expect(screen.getByRole('button')).toHaveTextContent('toolCall.denied')
  })

  it('counts web search results on the line once the search is done', () => {
    const presentation = {
      kind: 'web_search_exa' as const,
      title: 'Searched: nemotron',
      query: 'nemotron',
      results: [
        { title: 'One', url: 'https://a.example/1', highlights: [] },
        { title: 'Two', url: 'https://b.example/2', highlights: [] },
      ],
    }
    const { rerender } = render(
      <ToolRenderer
        toolName="web_search_exa"
        state="input-available"
        presentation={presentation}
      />
    )
    expect(screen.getByRole('button')).not.toHaveTextContent('toolCall')

    rerender(
      <ToolRenderer
        toolName="web_search_exa"
        state="output-available"
        presentation={presentation}
      />
    )
    expect(screen.getByRole('button')).toHaveTextContent('nemotron')
    expect(screen.getByRole('button')).toHaveTextContent('toolCall.results:2')
  })
})
