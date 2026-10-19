import { useEffect } from 'react'
import { create } from 'zustand'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useThreads } from '@/hooks/useThreads'
import type {
  ChatExecStatus,
  SecureEnvironment,
} from '@/services/chat-exec/types'

type SecureEnvironmentsState = {
  /** By project id. Empty until the first load answers. */
  environments: Record<string, SecureEnvironment>
}

/**
 * Secure environment projects. The backend owns the policy
 * (`<data>/secure-environments.json`) and enforces it on every command by
 * the thread's own project; this store is the UI's copy, used to edit it,
 * to describe the tools to the model and to word the approval.
 */
export const useSecureEnvironments = create<SecureEnvironmentsState>()(() => ({
  environments: {},
}))

let load: Promise<void> | null = null

export function ensureSecureEnvironmentsLoaded(): Promise<void> {
  if (load) return load
  load = (async () => {
    try {
      const environments = await getServiceHub()
        .chatExec()
        .secureEnvironments()
      useSecureEnvironments.setState({ environments })
    } catch (error) {
      console.warn('Could not read the secure environments:', error)
      load = null
    }
  })()
  return load
}

/** Save one project's policy (`null` turns it off) and keep the copy in step. */
export async function saveSecureEnvironment(
  projectId: string,
  environment: SecureEnvironment | null
): Promise<void> {
  await getServiceHub().chatExec().setSecureEnvironment(projectId, environment)
  useSecureEnvironments.setState((state) => {
    const environments = { ...state.environments }
    if (environment) environments[projectId] = environment
    else delete environments[projectId]
    return { environments }
  })
}

/** The policy of the project a thread belongs to, if it is a secure one. */
export function secureEnvironmentForThread(
  threadId: string | undefined
): SecureEnvironment | undefined {
  if (!threadId) return undefined
  const projectId =
    useThreads.getState().threads[threadId]?.metadata?.project?.id
  if (!projectId) return undefined
  return useSecureEnvironments.getState().environments[projectId]
}

export type SecureEnvironmentAvailability =
  | { kind: 'available' }
  /** Windows, but MXC did not pass its probe here. */
  | { kind: 'unavailable'; reason: string | null }
  /** Not offered on this OS at all (for now: anything but Windows). */
  | { kind: 'hidden' }

/**
 * Secure environments are enforced by Microsoft MXC, so for now they exist
 * only on Windows, and can be switched on only where MXC passed its probe.
 */
export function secureEnvironmentAvailability(
  status: ChatExecStatus | null
): SecureEnvironmentAvailability {
  if (!status?.supported || status.os !== 'windows') return { kind: 'hidden' }
  if (status.sandbox.kind !== 'mxc') {
    return { kind: 'unavailable', reason: status.sandbox.reason }
  }
  return { kind: 'available' }
}

/**
 * Why a secure project keeps a connector (an MCP server) out of its chats:
 * `notAllowed` when the project does not list it, `network` for a web search
 * server while the project's internet access is off. `null`: usable.
 */
export type ConnectorBlock = 'notAllowed' | 'network' | null

export function connectorBlock(
  environment: SecureEnvironment | undefined,
  serverKey: string,
  webSearch: boolean
): ConnectorBlock {
  if (!environment) return null
  if (!environment.allowedMcpServers.includes(serverKey)) return 'notAllowed'
  if (webSearch && !environment.network) return 'network'
  return null
}

/**
 * The secure policy that applies to the composer: the open thread's project,
 * or — composing a project's first message — that project.
 */
export function useComposerSecureEnvironment(
  initialMessage: boolean,
  projectId?: string
): SecureEnvironment | undefined {
  const threadProjectId = useThreads((state) =>
    initialMessage
      ? undefined
      : state.threads[state.currentThreadId ?? '']?.metadata?.project?.id
  )
  const id = projectId ?? threadProjectId
  const environment = useSecureEnvironments((state) =>
    id ? state.environments[id] : undefined
  )
  useEffect(() => {
    void ensureSecureEnvironmentsLoaded()
  }, [])
  return environment
}
