import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ToolUIPart } from 'ai'
import chat from '@/locales/en/chat.json'
import { ToolRenderer } from './tool-renderer'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const value = key
        .split('.')
        .reduce<unknown>(
          (part, segment) => (part as Record<string, unknown>)?.[segment],
          chat
        )
      return String(value ?? key).replace(/{{(\w+)}}/g, (_, name) =>
        String(options?.[name] ?? '')
      )
    },
  }),
}))

const actions = [
  [
    'os.fs.write',
    'Creating test_document.txt on Desktop…',
    'Created test_document.txt on Desktop',
    'Could not create test_document.txt on Desktop',
  ],
  [
    'os.fs.read',
    'Reading test_document.txt…',
    'Read test_document.txt',
    'Could not read test_document.txt',
  ],
  [
    'os.fs.list',
    'Looking through files…',
    'Looked through files',
    'Could not look through files',
  ],
  [
    'os.fs.glob',
    'Looking through files…',
    'Looked through files',
    'Could not look through files',
  ],
  [
    'os.fs.mkdir',
    'Creating folder…',
    'Created folder',
    'Could not create folder',
  ],
  ['os.shell.run', 'Running a command…', 'Ran a command', 'Command failed'],
  [
    'os.web.search',
    'Searching the web…',
    'Searched the web',
    'Web search failed',
  ],
  [
    'os.web.fetch',
    'Reading web page…',
    'Read web page',
    'Could not read web page',
  ],
] as const
const states = [
  'input-streaming',
  'input-available',
  'output-available',
  'output-error',
] as const

describe('ToolRenderer friendly activity', () => {
  beforeAll(() =>
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    )
  )
  afterAll(() => vi.unstubAllGlobals())

  it.each(
    actions.flatMap(([toolName, running, success, error]) =>
      states.map((state) => ({
        toolName,
        state,
        expected: state.startsWith('input-')
          ? running
          : state === 'output-error'
            ? error
            : success,
      }))
    )
  )(
    '$toolName / $state describes the action',
    ({ toolName, state, expected }) => {
      render(
        <ToolRenderer
          toolName={toolName}
          state={state}
          presentation={{
            kind: 'generic',
            title: toolName,
            subtitle: '/Users/atomic/Desktop/test_document.txt',
            input: { path: '/Users/atomic/Desktop/test_document.txt' },
            errorText:
              state === 'output-error'
                ? 'Error at /Users/atomic/private/file.txt'
                : undefined,
          }}
        />
      )
      const row = screen.getByRole('button', { name: expected })
      expect(row).toHaveTextContent(expected)
      expect(row).not.toHaveTextContent(toolName)
      expect(row).not.toHaveTextContent('/Users/')
      expect(row).toHaveAttribute('title', expected)
      expect(row).toHaveAttribute('aria-expanded', 'false')
    }
  )

  it.each([
    ['C:\\Users\\Atomic\\Desktop\\test.txt', 'test.txt on Desktop'],
    ['\\\\?\\C:\\Users\\Atomic\\Documents\\test.txt', 'test.txt in Documents'],
    ['\\\\server\\share\\work\\test.txt', 'test.txt in work'],
    ['/home/atomic/test.txt', 'test.txt in Home'],
    ['/Users/atomic/test.txt', 'test.txt in Home'],
    ['~/Downloads/test.txt', 'test.txt in Downloads'],
    ['/workspace/project/test.txt', 'test.txt in project'],
    [
      '/Users/atomic/Documents/project/deep/folder/test.txt',
      'test.txt in folder',
    ],
    ['test.txt', 'test.txt'],
    ['/a/'.repeat(50) + 'test.txt', 'test.txt in a'],
  ])('shortens %s without exposing its prefix', (path, target) => {
    render(
      <ToolRenderer
        toolName="os.fs.write"
        state="output-available"
        presentation={{ kind: 'generic', title: 'Wrote file', input: { path } }}
      />
    )
    expect(screen.getByRole('button')).toHaveAccessibleName(`Created ${target}`)
    expect(screen.getByRole('button')).not.toHaveTextContent(
      path.includes('/') || path.includes('\\') ? path : 'os.fs.write'
    )
  })

  it.each([
    ['input-available', 'Weather forecast — working…'],
    ['output-available', 'Weather forecast — completed'],
    ['output-error', 'Weather forecast — failed'],
    ['output-denied', 'Weather forecast — denied'],
  ])('humanizes an unknown title in %s', (state, label) => {
    render(
      <ToolRenderer
        toolName="vendor.weather_forecast"
        state={state as ToolUIPart['state']}
        presentation={{
          kind: 'generic',
          title: 'vendor.weather_forecast',
          subtitle: '/Users/atomic/private.txt',
        }}
      />
    )
    expect(screen.getByRole('button')).toHaveAccessibleName(label)
    expect(screen.getByRole('button')).not.toHaveTextContent('/Users/')
  })

  it('uses a supplied human title and strips an embedded absolute path', () => {
    render(
      <ToolRenderer
        toolName="vendor.inspect"
        state="output-available"
        presentation={{
          kind: 'generic',
          title: 'Inspect document /Users/atomic/My Files/test.txt',
        }}
      />
    )
    expect(screen.getByRole('button')).toHaveAccessibleName(
      'Inspect document — completed'
    )
  })

  it.each([
    ['os.fs.write', 'Creating file was denied'],
    ['os.fs.read', 'Reading file was denied'],
    ['os.fs.list', 'Looking through files was denied'],
    ['os.fs.mkdir', 'Creating folder was denied'],
    ['os.shell.run', 'Command was denied'],
    ['os.web.search', 'Web search was denied'],
    ['os.web.fetch', 'Reading web page was denied'],
  ])('describes denied %s without claiming success', (toolName, label) => {
    render(
      <ToolRenderer
        toolName={toolName}
        state={'output-denied' as never}
        presentation={{ kind: 'generic', title: toolName }}
      />
    )
    expect(screen.getByRole('button')).toHaveAccessibleName(label)
  })

  it.each([
    [
      'os.web.search',
      { query: 'local models' },
      'Searched the web: local models',
    ],
    [
      'os.web.fetch',
      { url: 'https://example.com/private/page' },
      'Read web page: example.com',
    ],
  ])('retains generic web context for %s', (toolName, input, label) => {
    render(
      <ToolRenderer
        toolName={toolName}
        state="output-available"
        presentation={{ kind: 'generic', title: toolName, input }}
      />
    )
    expect(screen.getByRole('button')).toHaveAccessibleName(label)
  })

  it('has a useful label before a path arrives', () => {
    render(
      <ToolRenderer
        toolName="os.fs.read"
        state="input-streaming"
        presentation={{ kind: 'generic', title: 'Read file', input: null }}
      />
    )
    expect(screen.getByRole('button')).toHaveAccessibleName('Reading file…')
  })

  it('keeps original parameters and errors in the expanded disclosure', async () => {
    const path = '/Users/atomic/Desktop/test_document.txt'
    const { container } = render(
      <ToolRenderer
        toolName="os.fs.write"
        state="output-error"
        presentation={{
          kind: 'generic',
          title: 'Write failed',
          input: { path, content: 'hello' },
          errorText: `Permission denied: ${path}`,
        }}
      />
    )
    expect(container).not.toHaveTextContent(path)
    await userEvent.click(screen.getByRole('button'))
    expect(screen.getByText('Parameters')).toBeInTheDocument()
    expect(screen.queryByText('os.fs.write')).not.toBeInTheDocument()
    expect(container).toHaveTextContent(path)
    expect(container).toHaveTextContent(`Permission denied: ${path}`)
  })

  it.each(states)('retains friendly web search context in %s', (state) => {
    render(
      <ToolRenderer
        toolName="web_search_exa"
        state={state}
        presentation={{
          kind: 'web_search_exa',
          title: 'Searched: nemotron',
          query: 'nemotron',
          results: [
            { title: 'One', highlights: [] },
            { title: 'Two', highlights: [] },
          ],
        }}
      />
    )
    const row = screen.getByRole('button')
    expect(row).toHaveTextContent('nemotron')
    expect(row).not.toHaveTextContent('web_search_exa')
    if (state === 'output-available')
      expect(row).toHaveAccessibleDescription('2 results')
    expect(row.textContent?.includes('2 results')).toBe(
      state === 'output-available'
    )
  })

  it('uses a web page hostname instead of the full URL', () => {
    render(
      <ToolRenderer
        toolName="web_fetch_exa"
        state="output-error"
        presentation={{
          kind: 'web_fetch_exa',
          title: 'Fetched pages',
          urls: ['https://developer.nvidia.com/nemotron'],
          pages: [],
        }}
      />
    )
    expect(screen.getByRole('button')).toHaveAccessibleName(
      'Could not read web page: developer.nvidia.com'
    )
  })
})
