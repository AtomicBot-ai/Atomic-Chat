import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InvokeArgs } from '@tauri-apps/api/core'
import { mockIPC } from '@tauri-apps/api/mocks'
import { DEFAULT_MCP_SETTINGS } from '@/hooks/useMCPServers'
import { APIs } from '@/lib/service'
import { seedServiceHub } from '@/test/service-hub'
import { TauriCoreService } from '../core/tauri'
import { TauriMCPService } from '../mcp/tauri'

describe('TauriMCPService', () => {
  let mcpService: TauriMCPService
  let ipcHandler: ReturnType<typeof vi.fn>

  beforeEach(() => {
    ipcHandler = vi.fn()
    mockIPC((command: string, args?: InvokeArgs) => ipcHandler(command, args))
    seedServiceHub({ core: new TauriCoreService() })
    window.core = {
      api: APIs,
      extensionManager: undefined,
    }
    mcpService = new TauriMCPService()
  })

  it('routes configuration writes and restart through the real API facade', async () => {
    ipcHandler.mockReturnValue(undefined)

    await mcpService.updateMCPConfig('{"server":{}}')
    await mcpService.restartMCPServers()

    expect(ipcHandler.mock.calls).toEqual([
      ['save_mcp_configs', { configs: '{"server":{}}' }],
      ['restart_mcp_servers', {}],
    ])
  })

  it('normalizes a legacy MCP server map from real invoke', async () => {
    ipcHandler.mockReturnValue('{"filesystem":{"command":"filesystem-server"}}')

    await expect(mcpService.getMCPConfig()).resolves.toEqual({
      mcpServers: {
        filesystem: { command: 'filesystem-server' },
      },
      mcpSettings: { ...DEFAULT_MCP_SETTINGS },
    })
    expect(ipcHandler).toHaveBeenCalledWith('get_mcp_configs', {})
  })

  it.each([null, undefined, '', '   '])(
    'returns defaults for an empty backend response',
    async (response) => {
      ipcHandler.mockReturnValue(response)

      await expect(mcpService.getMCPConfig()).resolves.toEqual({
        mcpServers: {},
        mcpSettings: { ...DEFAULT_MCP_SETTINGS },
      })
    }
  )

  it('rejects malformed backend configuration JSON', async () => {
    ipcHandler.mockReturnValue('{"invalid": json}')

    await expect(mcpService.getMCPConfig()).rejects.toThrow()
  })

  it('drops legacy unused MCP restart settings', async () => {
    ipcHandler.mockReturnValue(
      JSON.stringify({
        mcpServers: {},
        mcpSettings: {
          toolCallTimeoutSeconds: 12,
          baseRestartDelayMs: 1000,
          maxRestartDelayMs: 30000,
          backoffMultiplier: 2,
        },
      })
    )

    await expect(mcpService.getMCPConfig()).resolves.toEqual({
      mcpServers: {},
      mcpSettings: { toolCallTimeoutSeconds: 12 },
    })
  })

  it('routes tool discovery and invocation through the real API facade', async () => {
    const tools = [{ name: 'read_file', inputSchema: { type: 'object' } }]
    const statuses = [
      { name: 'filesystem', status: 'connected' as const },
    ]
    const toolResult = {
      error: '',
      content: [{ text: 'contents' }],
    }
    ipcHandler.mockImplementation((command: string) => {
      if (command === 'get_tools') return { tools, servers: statuses }
      if (command === 'get_connected_servers') return ['filesystem']
      if (command === 'get_mcp_server_statuses') return statuses
      if (command === 'call_tool') return toolResult
      return undefined
    })

    await expect(mcpService.getTools()).resolves.toEqual(tools)
    await expect(mcpService.getConnectedServers()).resolves.toEqual([
      'filesystem',
    ])
    await expect(mcpService.getMCPServerStatuses()).resolves.toEqual(statuses)
    await expect(
      mcpService.callTool({
        toolName: 'read_file',
        serverName: 'filesystem',
        arguments: { path: '/tmp/file.txt' },
      })
    ).resolves.toEqual(toolResult)

    expect(ipcHandler).toHaveBeenCalledWith('call_tool', {
      toolName: 'read_file',
      serverName: 'filesystem',
      arguments: { path: '/tmp/file.txt' },
    })
  })

  it('adds and forwards cancellation tokens through the real API facade', async () => {
    ipcHandler.mockReturnValue({
      error: '',
      content: [],
    })

    const call = mcpService.callToolWithCancellation({
      toolName: 'read_file',
      arguments: {},
      cancellationToken: 'token-1',
    })

    await expect(call.promise).resolves.toEqual({ error: '', content: [] })
    await call.cancel()

    expect(call.token).toBe('token-1')
    expect(ipcHandler.mock.calls).toEqual([
      [
        'call_tool',
        {
          toolName: 'read_file',
          arguments: {},
          cancellationToken: 'token-1',
        },
      ],
      ['cancel_tool_call', { cancellationToken: 'token-1' }],
    ])
  })

  it('invokes direct MCP lifecycle commands', async () => {
    ipcHandler.mockImplementation((command: string) =>
      command === 'check_jan_browser_extension_connected' ? true : undefined
    )
    const config = {
      command: 'node',
      args: ['server.js'],
      env: {},
    }

    await mcpService.activateMCPServer('filesystem', config)
    await mcpService.deactivateMCPServer('filesystem')
    await expect(mcpService.checkJanBrowserExtensionConnected()).resolves.toBe(
      true
    )

    expect(ipcHandler.mock.calls).toEqual([
      ['activate_mcp_server', { name: 'filesystem', config }],
      ['deactivate_mcp_server', { name: 'filesystem' }],
      ['check_jan_browser_extension_connected', {}],
    ])
  })

  it('keeps optional window.core calls as graceful no-ops', async () => {
    window.core = undefined

    await expect(mcpService.updateMCPConfig('{}')).resolves.toBeUndefined()
    await expect(mcpService.getTools()).resolves.toBeUndefined()
  })
})
