/**
 * The pending chat media request that the settings popup is presenting.
 *
 * When the composer is in media mode and the user sends, the thread page parks
 * the prompt here instead of generating immediately. The popup resolves the
 * model's choices, lets the user pick "use last used settings" or a specific
 * resolution/length, and only then runs the job through `chatGeneration`.
 */

import { create } from 'zustand'

import type { ChatMediaTaskId } from '@/services/media/chatGeneration'

export type PendingMediaChat = {
  task: ChatMediaTaskId
  text: string
}

type MediaChatSettingsState = {
  pending: PendingMediaChat | null
  open: (pending: PendingMediaChat) => void
  close: () => void
}

export const useMediaChatSettings = create<MediaChatSettingsState>()((set) => ({
  pending: null,
  open: (pending) => set({ pending }),
  close: () => set({ pending: null }),
}))
