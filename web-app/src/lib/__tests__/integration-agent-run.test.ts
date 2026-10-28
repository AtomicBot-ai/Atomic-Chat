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

import { INTEGRATION_AGENTS } from '@/constants/integrations'
import { useLaunchStore } from '@/stores/launch-store'

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
    useLaunchStore.setState({ launched: {}, binPath: {} })
  })

  it('runs a terminal agent and remembers it opened', async () => {
    const opened = await openIntegrationAgent(agent('codex'), {
      t,
      model: 'qwen3.5-4b',
      server,
    })

    expect(opened).toBe(true)
    expect(invoke).toHaveBeenCalledWith('open_agent_terminal', {
      command: `ATOMIC_CHAT_API_KEY='it'\\''s-secret' 'codex' '--profile' 'atomic-chat'`,
      proxy: undefined,
    })
    expect(useLaunchStore.getState().launched).toEqual({ codex: true })
  })

  it('opens a desktop agent in its own app, not a terminal', async () => {
    await openIntegrationAgent(agent('zed'), { t, model: null, server })

    expect(invoke).toHaveBeenCalledWith('launch_zed', { apiKey: server.apiKey })
    expect(invoke).not.toHaveBeenCalledWith(
      'open_agent_terminal',
      expect.anything()
    )
    expect(useLaunchStore.getState().launched).toEqual({ zed: true })
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
    expect(useLaunchStore.getState().launched).toEqual({})
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

  it.each(['muse', 'poolside', 'codex'])(
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
