import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const AGENT_HOME_DRAFT = 'pi-agent-home'
export type ChatMode = 'chat' | 'agent'
type Memory = {
  mode: ChatMode
  select: (mode: ChatMode) => void
}
export const useChatMode = create<Memory>()(
  persist(
    (set) => ({
      mode: 'chat',
      select: (mode) =>
        set((state) => (state.mode === mode ? state : { mode })),
    }),
    { name: 'atomic-chat-mode' }
  )
)

export const homeFor = (mode: ChatMode) => (mode === 'agent' ? '/agent' : '/')
export function projectDestination(projectId: string, mode: ChatMode) {
  return {
    to: '/project/$projectId' as const,
    params: { projectId },
    search: mode === 'agent' ? { mode: 'agent' as const } : {},
  }
}

export const currentModeHome = () => homeFor(useChatMode.getState().mode)
export const threadRoute = (thread: Pick<Thread, 'metadata'> | undefined) =>
  thread?.metadata?.kind === 'agent' ? '/agent/$threadId' : '/threads/$threadId'
