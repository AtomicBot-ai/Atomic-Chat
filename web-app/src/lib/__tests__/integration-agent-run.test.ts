import { execFileSync } from 'node:child_process'
import { type as osType } from '@tauri-apps/plugin-os'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))
vi.mock('@tauri-apps/plugin-os', () => ({ type: vi.fn(() => 'macos') }))
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), warning: vi.fn(), success: vi.fn(), error: vi.fn() },
}))
vi.mock('@/utils/servedModel', () => ({ servedContextLength: vi.fn() }))

import { INTEGRATION_AGENTS } from '@/constants/integrations'
import { useLaunchStore } from '@/stores/launch-store'
import { servedContextLength } from '@/utils/servedModel'

import { openIntegrationAgent } from '../integration-agent-run'

const agent = (id: string) => INTEGRATION_AGENTS.find((a) => a.id === id)!
const t = (key: string) => key
const server = {
  serverHost: '0.0.0.0',
  serverPort: 1337,
  apiPrefix: '/v1',
  apiKey: "it's-secret",
}

describe('openIntegrationAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(osType).mockReturnValue('macos')
    vi.mocked(invoke).mockResolvedValue(undefined)
    vi.mocked(servedContextLength).mockResolvedValue(undefined)
    useLaunchStore.setState({ opened: {}, connected: {}, binPath: {} })
  })

  const terminalCommand = () =>
    (
      vi
        .mocked(invoke)
        .mock.calls.find(([name]) => name === 'open_agent_terminal')?.[1] as {
        command: string
      }
    ).command

  it('starts Kilo on our model, which beats the pick it saved', async () => {
    await openIntegrationAgent(agent('kilo'), {
      t,
      model: 'qwen3.5-4b',
      server,
    })
    expect(terminalCommand()).toBe(`'kilo' '--model' 'atomic/qwen3.5-4b'`)

    vi.mocked(invoke).mockClear()
    await openIntegrationAgent(agent('kilo'), { t, model: null, server })
    expect(terminalCommand()).toBe('kilo')
  })

  it.skipIf(process.platform === 'win32')(
    'gives Goose its provider, endpoint and window for this session only',
    async () => {
      vi.mocked(servedContextLength).mockResolvedValue(16384)
      await openIntegrationAgent(agent('goose'), {
        t,
        model: "org/model's $name",
        server: { ...server, apiPrefix: '/api/v1' },
      })
      const stub =
        'goose() { printf "%s\\n" "$GOOSE_PROVIDER" "$GOOSE_MODEL" "$OPENAI_BASE_URL" "$OPENAI_API_KEY" "$GOOSE_CONTEXT_LIMIT" "$GOOSE_MAX_TOKENS" "${OPENAI_HOST-unset}" "$@"; }; '
      const output = execFileSync('/bin/sh', ['-c', stub + terminalCommand()], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH },
      })
      expect(output.split('\n').slice(0, -1)).toEqual([
        'openai',
        "org/model's $name",
        'http://127.0.0.1:1337/api/v1',
        "it's-secret",
        '16384',
        '4096',
        'unset',
        'session',
      ])
    }
  )

  it('leaves the Goose window unset when the server does not say it', async () => {
    await openIntegrationAgent(agent('goose'), {
      t,
      model: 'qwen3',
      server: { ...server, apiKey: '' },
    })
    expect(terminalCommand()).toBe(
      `GOOSE_PROVIDER='openai' GOOSE_MODEL='qwen3' OPENAI_BASE_URL='http://127.0.0.1:1337/v1' OPENAI_API_KEY='atomic' 'goose' 'session'`
    )
  })

  it('runs a terminal agent, titled for it, and remembers it opened', async () => {
    const opened = await openIntegrationAgent(agent('codex'), {
      t,
      model: 'qwen3.5-4b',
      server,
    })

    expect(opened).toBe(true)
    expect(invoke).toHaveBeenCalledWith('open_agent_terminal', {
      command: `ATOMIC_CHAT_API_KEY='it'\\''s-secret' 'codex' '--profile' 'atomic-chat'`,
      proxy: undefined,
      agent: {
        agentId: 'codex',
        agentName: 'Codex CLI',
        endpoint: 'http://127.0.0.1:1337/v1',
        model: 'qwen3.5-4b',
      },
    })
    expect(useLaunchStore.getState().opened).toEqual({
      codex: { at: expect.any(Number), model: 'qwen3.5-4b' },
    })
    expect(useLaunchStore.getState().connected).toEqual({ codex: false })
  })

  it('names the bare endpoint an agent without the API prefix is given', async () => {
    await openIntegrationAgent(agent('claude-code'), { t, model: null, server })

    expect(invoke).toHaveBeenCalledWith(
      'open_agent_terminal',
      expect.objectContaining({
        agent: expect.objectContaining({ endpoint: 'http://127.0.0.1:1337' }),
      })
    )
    expect(useLaunchStore.getState().opened).toEqual({
      'claude-code': { at: expect.any(Number), model: null },
    })
  })

  it('keeps what it knew of an agent whose running terminal came forward', async () => {
    useLaunchStore.setState({
      opened: { codex: { at: 5, model: 'qwen3.5-4b' } },
      connected: { codex: true },
    })
    vi.mocked(invoke).mockResolvedValueOnce('focused')

    const opened = await openIntegrationAgent(agent('codex'), {
      t,
      model: 'qwen3.5-4b',
      server,
    })

    expect(opened).toBe(true)
    expect(useLaunchStore.getState()).toMatchObject({
      opened: { codex: { at: 5 } },
      connected: { codex: true },
    })

    // A new window is a new process: heard from again before it is connected.
    vi.mocked(invoke).mockResolvedValueOnce('opened')
    await openIntegrationAgent(agent('codex'), {
      t,
      model: 'qwen3.5-4b',
      server,
    })
    expect(useLaunchStore.getState().opened.codex.at).toBeGreaterThan(5)
    expect(useLaunchStore.getState().connected).toEqual({ codex: false })
  })

  it('says where to allow Terminal when macOS refuses Automation', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(
      'Terminal did not open: execution error: Not authorized to send Apple events to Terminal. (-1743)'
    )

    const opened = await openIntegrationAgent(agent('codex'), {
      t,
      model: null,
      server,
    })

    expect(opened).toBe(false)
    expect(toast.warning).toHaveBeenCalledWith('launch:toast.terminalFailed', {
      description: 'launch:toast.terminalNotAllowedDesc',
    })
    expect(useLaunchStore.getState().opened).toEqual({})
  })

  it('opens a desktop agent in its own app, not a terminal', async () => {
    await openIntegrationAgent(agent('zed'), { t, model: null, server })

    expect(invoke).toHaveBeenCalledWith('launch_zed', {
      apiKey: server.apiKey,
      path: null,
    })
    expect(invoke).not.toHaveBeenCalledWith(
      'open_agent_terminal',
      expect.anything()
    )
    expect(useLaunchStore.getState().opened).toEqual({
      zed: { at: expect.any(Number), model: null },
    })
  })

  it('opens Zed through the launcher detection found off PATH', async () => {
    const cli = '/Applications/Zed.app/Contents/MacOS/cli'
    useLaunchStore.setState({ binPath: { zed: cli } })

    await openIntegrationAgent(agent('zed'), { t, model: null, server })

    expect(invoke).toHaveBeenCalledWith('launch_zed', {
      apiKey: server.apiKey,
      path: cli,
    })
    expect(useLaunchStore.getState().opened).toEqual({
      zed: { at: expect.any(Number), model: null },
    })
  })

  it('warns instead of throwing when the terminal does not open', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('no terminal app'))

    const opened = await openIntegrationAgent(agent('opencode'), {
      t,
      model: null,
      server,
    })

    expect(opened).toBe(false)
    expect(toast.warning).toHaveBeenCalledWith('launch:toast.terminalFailed', {
      description: 'no terminal app',
    })
    expect(useLaunchStore.getState().opened).toEqual({})
  })
  it.skipIf(process.platform === 'win32').each(['muse', 'poolside'])(
    'preserves %s arguments through a POSIX shell',
    async (id) => {
      const value = "it's a $value `not-a-command` $(not-a-command)"
      const model = "org/model's spaced $id `literal`"
      await openIntegrationAgent(agent(id), {
        t,
        model,
        server: { ...server, apiKey: value, apiPrefix: "/path's $literal/v1" },
      })
      const command = (
        vi
          .mocked(invoke)
          .mock.calls.find(([name]) => name === 'open_agent_terminal')?.[1] as {
          command: string
        }
      ).command
      const stub =
        id === 'muse'
          ? 'muse() { printf "%s\\n" "$META_API_KEY" "$@"; }; '
          : 'pool() { printf "%s\\n" "$POOLSIDE_API_KEY" "$POOLSIDE_STANDALONE_BASE_URL" "$POOLSIDE_STANDALONE_MODEL"; }; '
      const output = execFileSync('/bin/sh', ['-c', stub + command], {
        encoding: 'utf8',
      })
        .trim()
        .split('\n')
      expect(output[0]).toBe(value)
      expect(output.at(-1)).toBe(model)
      expect(output).toContain(
        id === 'muse'
          ? "http://127.0.0.1:1337/path's $literal/v1"
          : "http://127.0.0.1:1337/path's $literal"
      )
    }
  )

  it.skipIf(process.platform === 'win32')(
    'starts Copilot on our providers.json model, the id intact',
    async () => {
      const model = "org/model's spaced $id `literal`"
      await openIntegrationAgent(agent('copilot'), { t, model, server })
      const command = (
        vi
          .mocked(invoke)
          .mock.calls.find(([name]) => name === 'open_agent_terminal')?.[1] as {
          command: string
        }
      ).command
      // No variable is set for the run: the key lives in providers.json.
      expect(command.startsWith("'copilot' ")).toBe(true)
      const output = execFileSync(
        '/bin/sh',
        ['-c', 'copilot() { printf "%s\\n" "$@"; }; ' + command],
        { encoding: 'utf8' }
      )
      expect(output.trim().split('\n')).toEqual([
        '--model',
        `atomic-chat/${model}`,
      ])
    }
  )

  it('starts a bare Copilot when no model is loaded', async () => {
    await openIntegrationAgent(agent('copilot'), { t, model: null, server })
    expect(
      vi
        .mocked(invoke)
        .mock.calls.find(([name]) => name === 'open_agent_terminal')?.[1]
    ).toEqual(expect.objectContaining({ command: 'copilot', proxy: undefined }))
    expect(useLaunchStore.getState().opened).toEqual({
      copilot: { at: expect.any(Number), model: null },
    })
  })

  it.each(['muse', 'poolside', 'codex', 'goose'])(
    'encodes %s data before crossing cmd.exe on Windows',
    async (id) => {
      vi.mocked(osType).mockReturnValue('windows')
      const value = "it's $secret `literal` & %PATH% !x!"
      await openIntegrationAgent(agent(id), {
        t,
        model: "org/model's name",
        server: { ...server, apiKey: value },
      })
      const command = (
        vi
          .mocked(invoke)
          .mock.calls.find(([name]) => name === 'open_agent_terminal')?.[1] as {
          command: string
        }
      ).command
      expect(command).toMatch(
        /^powershell.exe -NoProfile -EncodedCommand [A-Za-z0-9+/=]+$/
      )
      const script = Buffer.from(command.split(' ').at(-1)!, 'base64').toString(
        'utf16le'
      )
      expect(script).toContain("='it''s $secret `literal` & %PATH% !x!'")
      expect(script).toContain(`& '${agent(id).detectBin}'`)
      if (id !== 'codex') expect(script).toContain("'org/model''s name'")
    }
  )
})
