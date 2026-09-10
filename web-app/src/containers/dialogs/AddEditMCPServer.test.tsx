import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AddEditMCPServer from '@/containers/dialogs/AddEditMCPServer'
import { useMCPServers, type MCPServerConfig } from '@/hooks/useMCPServers'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, string>) =>
      vars ? `${key}:${Object.values(vars).join(',')}` : key,
  }),
}))

// The code editor pulls in a CSS import that jsdom cannot parse.
vi.mock('@uiw/react-textarea-code-editor', () => ({
  default: ({
    value,
    onChange,
  }: {
    value: string
    onChange: (e: { target: { value: string } }) => void
  }) => (
    <textarea
      data-testid="json-editor"
      value={value}
      onChange={(e) => onChange({ target: { value: e.target.value } })}
    />
  ),
}))
vi.mock('@uiw/react-textarea-code-editor/dist.css', () => ({}))

const onSave = vi.fn()
const onOpenChange = vi.fn()

const renderDialog = (
  props: Partial<{
    editingKey: string | null
    initialData?: MCPServerConfig
  }> = {}
) =>
  render(
    <AddEditMCPServer
      open
      onOpenChange={onOpenChange}
      editingKey={props.editingKey ?? null}
      initialData={props.initialData}
      onSave={onSave}
    />
  )

const field = (label: string) =>
  screen.getByText(label).parentElement!.querySelector('input')!

const save = () => screen.getByRole('button', { name: 'mcp-servers:save' })

describe('AddEditMCPServer', () => {
  beforeEach(() => {
    onSave.mockReset()
    onOpenChange.mockReset()
    useMCPServers.setState({ mcpServers: {} })
  })

  it('parses a stdio command line into command and args', async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.type(field('mcp-servers:serverName'), 'my-server')
    await user.type(field('mcp-servers:command'), 'npx -y pkg ~/Docs')
    await user.click(save())

    expect(onSave).toHaveBeenCalledWith('my-server', {
      command: 'npx',
      args: ['-y', 'pkg', '~/Docs'],
      env: {},
      type: 'stdio',
      cwd: undefined,
      timeout: undefined,
      url: undefined,
      headers: undefined,
    })
  })

  it('keeps quoted arguments intact', async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.type(field('mcp-servers:serverName'), 'quoted')
    await user.type(field('mcp-servers:command'), 'node "/a b/i.js"')
    await user.click(save())

    expect(onSave.mock.calls[0][1].args).toEqual(['/a b/i.js'])
  })

  it('saves a remote server with an explicit http transport', async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.type(field('mcp-servers:serverName'), 'remote')
    await user.click(
      screen.getByRole('button', { name: 'mcp-servers:connectionRemote' })
    )
    await user.type(field('mcp-servers:url'), 'https://example.com/mcp')
    await user.click(save())

    expect(onSave).toHaveBeenCalledWith(
      'remote',
      expect.objectContaining({
        type: 'http',
        url: 'https://example.com/mcp',
        command: '',
        args: [],
        env: {},
      })
    )
  })

  it('supports the SSE transport override', async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.type(field('mcp-servers:serverName'), 'legacy')
    await user.click(
      screen.getByRole('button', { name: 'mcp-servers:connectionRemote' })
    )
    await user.type(field('mcp-servers:url'), 'https://example.com/sse')
    await user.click(screen.getByText('mcp-servers:showAdvanced'))
    await user.selectOptions(screen.getByRole('combobox'), 'sse')
    await user.click(save())

    expect(onSave.mock.calls[0][1].type).toBe('sse')
  })

  it('blocks an unparseable URL', async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.type(field('mcp-servers:serverName'), 'bad-url')
    await user.click(
      screen.getByRole('button', { name: 'mcp-servers:connectionRemote' })
    )
    await user.type(field('mcp-servers:url'), 'http://')
    await user.click(save())

    expect(
      screen.getByText('mcp-servers:formErrors.urlInvalid')
    ).toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('adds a missing scheme to a bare host', async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.type(field('mcp-servers:serverName'), 'bare')
    await user.click(
      screen.getByRole('button', { name: 'mcp-servers:connectionRemote' })
    )
    await user.type(field('mcp-servers:url'), 'example.com/mcp')
    await user.click(save())

    expect(onSave.mock.calls[0][1].url).toBe('https://example.com/mcp')
  })

  it('rejects an env-style command prefix', async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.type(field('mcp-servers:serverName'), 'env-prefix')
    await user.type(field('mcp-servers:command'), 'FOO=bar npx x')
    await user.click(save())

    expect(
      screen.getByText('mcp-servers:formErrors.commandEnvPrefix')
    ).toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('rejects an unclosed quote', async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.type(field('mcp-servers:serverName'), 'quote')
    await user.type(field('mcp-servers:command'), 'echo "oops')
    await user.click(save())

    expect(
      screen.getByText('mcp-servers:formErrors.commandUnterminatedQuote')
    ).toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('round-trips an edited stdio server without changes', async () => {
    const user = userEvent.setup()
    const initialData: MCPServerConfig = {
      command: 'npx',
      args: ['-y', 'pkg'],
      env: {},
      official: true,
      active: true,
    }
    useMCPServers.setState({ mcpServers: { existing: initialData } })
    renderDialog({ editingKey: 'existing', initialData })

    await waitFor(() =>
      expect(field('mcp-servers:command')).toHaveValue('npx -y pkg')
    )
    await user.click(save())

    expect(onSave).toHaveBeenCalledWith(
      'existing',
      expect.objectContaining({
        command: 'npx',
        args: ['-y', 'pkg'],
        official: true,
        active: true,
      })
    )
  })

  it('auto-expands advanced options when the server uses them', async () => {
    const initialData: MCPServerConfig = {
      command: 'npx',
      args: [],
      env: { API_KEY: 'x' },
    }
    useMCPServers.setState({ mcpServers: { withEnv: initialData } })
    renderDialog({ editingKey: 'withEnv', initialData })

    await waitFor(() =>
      expect(screen.getByText('mcp-servers:hideAdvanced')).toBeInTheDocument()
    )
    expect(screen.getByDisplayValue('API_KEY')).toBeInTheDocument()
  })

  it('keeps advanced options collapsed for a plain server', () => {
    renderDialog()
    expect(screen.getByText('mcp-servers:showAdvanced')).toBeInTheDocument()
  })

  it('saves env rows, working directory, and timeout', async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.type(field('mcp-servers:serverName'), 'full')
    await user.type(field('mcp-servers:command'), 'npx pkg')
    await user.click(screen.getByText('mcp-servers:showAdvanced'))
    await user.type(screen.getByPlaceholderText('mcp-servers:key'), 'TOKEN')
    await user.type(screen.getByPlaceholderText('mcp-servers:value'), 'abc')
    await user.type(field('mcp-servers:cwd'), '/tmp/work')
    await user.type(field('mcp-servers:timeout'), '45')
    await user.click(save())

    expect(onSave).toHaveBeenCalledWith(
      'full',
      expect.objectContaining({
        env: { TOKEN: 'abc' },
        cwd: '/tmp/work',
        timeout: 45,
      })
    )
  })

  it('blocks a duplicate server name when adding', async () => {
    const user = userEvent.setup()
    useMCPServers.setState({
      mcpServers: { taken: { command: 'x', args: [], env: {} } },
    })
    renderDialog()

    await user.type(field('mcp-servers:serverName'), 'taken')
    await user.type(field('mcp-servers:command'), 'npx pkg')
    await user.click(save())

    expect(
      screen.getByText('mcp-servers:formErrors.nameExists:taken')
    ).toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('saves each server from JSON mode', async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByTitle('mcp-servers:addServerByJson'))
    // userEvent.type treats {} and [] as key descriptors, so set JSON directly.
    fireEvent.change(screen.getByTestId('json-editor'), {
      target: {
        value: '{"srv": {"command": "npx", "args": [], "env": {}}}',
      },
    })
    await user.click(save())

    expect(onSave).toHaveBeenCalledWith('srv', {
      command: 'npx',
      args: [],
      env: {},
    })
  })

  it('surfaces malformed JSON', async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(screen.getByTitle('mcp-servers:addServerByJson'))
    await user.type(screen.getByTestId('json-editor'), 'not json')
    await user.click(save())

    expect(
      screen.getByText('mcp-servers:editJson.errorFormat')
    ).toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
  })
})
