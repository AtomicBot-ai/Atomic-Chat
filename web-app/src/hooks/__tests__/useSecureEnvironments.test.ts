import { beforeEach, describe, expect, it } from 'vitest'
import {
  connectorBlock,
  secureEnvironmentAvailability,
  secureEnvironmentForThread,
  useSecureEnvironments,
} from '@/hooks/useSecureEnvironments'
import { useThreads } from '@/hooks/useThreads'
import type { ChatExecStatus } from '@/services/chat-exec/types'

const status = (overrides: Partial<ChatExecStatus>): ChatExecStatus => ({
  supported: true,
  os: 'windows',
  shell: 'cmd',
  languages: [],
  sandbox: { kind: 'mxc', reason: null },
  userFolders: [],
  ...overrides,
})

describe('secureEnvironmentAvailability', () => {
  it('is offered only on Windows, and only where MXC passed its probe', () => {
    expect(secureEnvironmentAvailability(status({}))).toEqual({
      kind: 'available',
    })
    expect(
      secureEnvironmentAvailability(
        status({ sandbox: { kind: 'none', reason: 'Windows 11 24H2 needed' } })
      )
    ).toEqual({ kind: 'unavailable', reason: 'Windows 11 24H2 needed' })
    expect(
      secureEnvironmentAvailability(
        status({ os: 'macos', shell: 'sh', sandbox: { kind: 'none', reason: null } })
      )
    ).toEqual({ kind: 'hidden' })
    expect(secureEnvironmentAvailability(null)).toEqual({ kind: 'hidden' })
  })
})

describe('secureEnvironmentForThread', () => {
  beforeEach(() => {
    useSecureEnvironments.setState({
      environments: {
        p1: { folders: [], network: false, allowedMcpServers: [] },
      },
    })
    useThreads.setState({
      threads: {
        inSecure: {
          id: 'inSecure',
          title: 'a',
          updated: 0,
          metadata: { project: { id: 'p1', name: 'P1', updated_at: 0 } },
        },
        inOther: {
          id: 'inOther',
          title: 'b',
          updated: 0,
          metadata: { project: { id: 'p2', name: 'P2', updated_at: 0 } },
        },
        loose: { id: 'loose', title: 'c', updated: 0 },
      },
    } as never)
  })

  it("finds the policy through the thread's own project", () => {
    expect(secureEnvironmentForThread('inSecure')).toEqual({
      folders: [],
      network: false,
      allowedMcpServers: [],
    })
    expect(secureEnvironmentForThread('inOther')).toBeUndefined()
    expect(secureEnvironmentForThread('loose')).toBeUndefined()
    expect(secureEnvironmentForThread(undefined)).toBeUndefined()
  })
})

describe('connectorBlock', () => {
  const policy = (network: boolean, allowed: string[]) => ({
    folders: [],
    network,
    allowedMcpServers: allowed,
  })

  it('blocks nothing outside a secure project', () => {
    expect(connectorBlock(undefined, 'notion', false)).toBeNull()
  })

  it('blocks a connector the project does not list', () => {
    expect(connectorBlock(policy(true, ['exa']), 'notion', false)).toBe(
      'notAllowed'
    )
  })

  it('blocks a listed web search server only while the internet is off', () => {
    expect(connectorBlock(policy(false, ['exa']), 'exa', true)).toBe('network')
    expect(connectorBlock(policy(true, ['exa']), 'exa', true)).toBeNull()
    expect(connectorBlock(policy(false, ['notion']), 'notion', false)).toBeNull()
  })
})
